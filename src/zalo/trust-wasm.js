/**
 * The trusted-device protocol of the Zalo login page, run in Node (plan item L15, second QR layer).
 *
 * An account that has a trusted device (a phone that signs a list of companion devices) is logged in on the web
 * in two steps: the phone scans the first QR, the page then makes a second one itself, from a token the server
 * answered the first scan with, and the phone scans that. The page makes it with a WebAssembly module
 * (`libzproto_wasm_bg.<hash>.wasm`, served next to the login script, Ed25519 plus the linking format) that this
 * file runs.
 *
 * The module is the page's, so it is fetched from the page at login time (see {@link wasmUrlOf}) and never
 * shipped here. What this file owns is the small loader around it: the `wasm-bindgen` calling convention (a table
 * of JS values behind small integers, strings and byte arrays copied through the module's own allocator, a
 * `Result` returned through a four-word slot on the module's stack), written for the six calls the login uses.
 *
 * Calls (names are the module's exports; argument order was read in the page's own trust worker):
 *  - `zprotoEd25519GenerateKeyPair()` a 33-byte public key (a type byte then the key) and a 32-byte private key;
 *  - `zprotoTrustGenerateLinkingSecretKey()` 32 random bytes;
 *  - `zprotoTrustGenerateLinkingQr(publicKey, secret|undefined, qrToken, timestamp, platform, relinkId|undefined)`
 *    the text the second QR encodes;
 *  - `zprotoTrustCreateCompanionLinkingProof(publicKey, privateKey, secret, primaryLinkingData, linkingHmac,
 *    platform)` the signatures the confirm call carries;
 *  - `zprotoTrustGetRelinkId(primaryKey, publicKey, secret, linkingTimestamp)` the id that says "this is the same
 *    device as last time" when a login uses an identity saved by an earlier one.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** The wasm file the login script names, as a full URL. */
const WASM_URL_PATTERN = /https:\/\/stc-zlogin\.zdn\.vn\/wasm\/libzproto_wasm_bg\.[0-9a-f]+\.wasm/;

/** The platform numbers of the trust library (`Mobile 0, Web 1, Pc 2`): this client is a Web client. */
export const TRUST_PLATFORM_WEB = 1;

/**
 * The wasm file a login script names.
 *
 * @param {string} scriptText - the login page's `main-<build>.js`
 * @returns {string|null}
 */
export function wasmUrlOf(scriptText) {
    return WASM_URL_PATTERN.exec(String(scriptText))?.[0] ?? null;
}

/**
 * Instantiate the module and return the calls the login needs.
 *
 * @param {Uint8Array|ArrayBuffer} wasmBytes
 * @returns {Promise<{
 *   generateIdentity: () => {publicKey: Uint8Array, privateKey: Uint8Array},
 *   generateLinkingSecret: () => Uint8Array,
 *   generateLinkingQr: (p: {publicKey: Uint8Array, secret?: Uint8Array, qrToken: string, timestamp: number|bigint,
 *       platform?: number, relinkId?: Uint8Array}) => string,
 *   createLinkingProof: (p: {publicKey: Uint8Array, privateKey: Uint8Array, secret: Uint8Array,
 *       primaryLinkingData: Uint8Array, linkingHmac: Uint8Array, platform?: number}) => {
 *       linkId: string, masterId: string, companionId: number, linkingTimestamp: number,
 *       primaryPublicIdentityKey: Uint8Array, linkingMetadata: Uint8Array, accountSignature: Uint8Array,
 *       deviceSignature: Uint8Array},
 *   getRelinkId: (p: {primaryKey: Uint8Array, publicKey: Uint8Array, secret: Uint8Array,
 *       linkingTimestamp: number|bigint}) => Uint8Array,
 * }>}
 */
export async function loadTrustWasm(wasmBytes) {
    /** The module's exports: set once it is instantiated, and read by the imports it is instantiated with. */
    // eslint-disable-next-line prefer-const
    let wasm;

    // The table of JS values the module refers to by number. Slots 0..127 are reserved by wasm-bindgen; 128..131 hold
    // undefined, null, true, false, and a freed slot points at the next free one.
    const heap = new Array(128).fill(undefined);
    heap.push(undefined, null, true, false);
    let heapNext = heap.length;
    const get = (index) => heap[index];
    const add = (value) => {
        if (heapNext === heap.length) heap.push(heap.length + 1);
        const index = heapNext;
        heapNext = heap[index];
        heap[index] = value;
        return index;
    };
    const take = (index) => {
        const value = heap[index];
        if (index >= 132) {
            heap[index] = heapNext;
            heapNext = index;
        }
        return value;
    };

    let bytes = null;
    const mem = () => {
        if (!bytes || bytes.byteLength === 0) bytes = new Uint8Array(wasm.memory.buffer);
        return bytes;
    };
    let view = null;
    const dv = () => {
        if (!view || view.buffer !== wasm.memory.buffer) view = new DataView(wasm.memory.buffer);
        return view;
    };

    const decoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
    const encoder = new TextEncoder();
    const readString = (ptr, len) => decoder.decode(mem().subarray(ptr >>> 0, (ptr >>> 0) + len));

    let lastLength = 0;
    /** Copy bytes into the module's memory; the length is left in `lastLength`. */
    const putBytes = (array) => {
        const ptr = wasm.__wbindgen_export_2(array.length, 1) >>> 0;
        mem().set(array, ptr);
        lastLength = array.length;
        return ptr;
    };
    const putString = (text) => {
        const encoded = encoder.encode(text);
        const ptr = wasm.__wbindgen_export_2(encoded.length, 1) >>> 0;
        mem()
            .subarray(ptr, ptr + encoded.length)
            .set(encoded);
        lastLength = encoded.length;
        return ptr;
    };
    const readBytes = (ptr, len) => mem().subarray(ptr >>> 0, (ptr >>> 0) + len);
    const isNil = (value) => value === undefined || value === null;

    /** Run a call that may throw into the module's exception slot; the module then reports it as a Result. */
    const guarded = (fn) =>
        function (...args) {
            try {
                return fn.apply(this, args);
            } catch (error) {
                wasm.__wbindgen_export_0(add(error));
            }
        };

    /**
     * What the module threw, as an Error. It throws plain `{code, message}` objects (`code` names the Rust error,
     * such as `TrustInvalidKeyType`), which a caller cannot tell from "[object Object]".
     */
    const failure = (reason) =>
        reason instanceof Error
            ? reason
            : Object.assign(new Error(String(reason?.message ?? reason)), { code: reason?.code });

    const wbg = {
        __wbg_apply_36be6a55257c99bf: guarded((f, thisArg, args) => add(get(f).apply(get(thisArg), get(args)))),
        __wbg_buffer_609cc3eee51ed158: (i) => add(get(i).buffer),
        __wbg_call_672a4d21634d4a24: guarded((f, thisArg) => add(get(f).call(get(thisArg)))),
        __wbg_call_7cccdd69e0791ae2: guarded((f, thisArg, arg) => add(get(f).call(get(thisArg), get(arg)))),
        __wbg_crypto_574e78ad8b13b65f: (i) => add(get(i).crypto),
        __wbg_done_769e5ede4b31c67b: (i) => get(i).done,
        __wbg_error_7534b8e9a36f1ab4: (ptr, len) => wasm.__wbindgen_export_1(ptr, len, 1),
        __wbg_getRandomValues_b8f5dbd5f3995a9e: guarded((i, array) => get(i).getRandomValues(get(array))),
        __wbg_get_67b2ba62fc30de12: guarded((target, key) => add(Reflect.get(get(target), get(key)))),
        __wbg_get_b9b93047fe3cf45b: (target, index) => add(get(target)[index >>> 0]),
        __wbg_getwithrefkey_1dc361bd10053bfe: (target, key) => add(get(target)[get(key)]),
        __wbg_instanceof_ArrayBuffer_e14585432e3737fc: (i) => get(i) instanceof ArrayBuffer,
        __wbg_instanceof_Uint8Array_17156bcf118086a9: (i) => get(i) instanceof Uint8Array,
        __wbg_isArray_a1eab7e0d067391b: (i) => Array.isArray(get(i)),
        __wbg_isSafeInteger_343e2beeeece1bb0: (i) => Number.isSafeInteger(get(i)),
        __wbg_iterator_9a24c88df860dc65: () => add(Symbol.iterator),
        __wbg_length_a446193dc22c12f8: (i) => get(i).length,
        __wbg_length_e2d2a49132c1b256: (i) => get(i).length,
        __wbg_msCrypto_a61aeb35a24c1329: (i) => add(get(i).msCrypto),
        __wbg_new_405e22f390576ce2: () => add(new Object()),
        __wbg_new_78feb108b6472713: () => add([]),
        __wbg_new_8a6f238a6ece86ea: () => add(new Error()),
        __wbg_new_a12002a7f91c75be: (i) => add(new Uint8Array(get(i))),
        __wbg_newnoargs_105ed471475aaf50: (ptr, len) => add(new Function(readString(ptr, len))),
        __wbg_newwithbyteoffsetandlength_d97e637ebe145a9a: (i, offset, length) =>
            add(new Uint8Array(get(i), offset >>> 0, length >>> 0)),
        __wbg_newwithlength_a381634e90c276d4: (length) => add(new Uint8Array(length >>> 0)),
        __wbg_next_25feadfc0913fea9: (i) => add(get(i).next),
        __wbg_next_6574e1a8a62d1055: guarded((i) => add(get(i).next())),
        __wbg_node_905d3e251edff8a2: (i) => add(get(i).node),
        __wbg_process_dc0fbacc7c1c06f7: (i) => add(get(i).process),
        __wbg_push_737cfc8c1432c2c6: (array, value) => get(array).push(get(value)),
        __wbg_randomFillSync_ac0988aba3254290: guarded((i, array) => get(i).randomFillSync(take(array))),
        __wbg_require_60cc747a6bc5215a: guarded(() => add(require)),
        __wbg_set_3f1d0b984ed272ed: (target, key, value) => {
            get(target)[take(key)] = take(value);
        },
        __wbg_set_65595bdd868b3009: (target, source, offset) => get(target).set(get(source), offset >>> 0),
        __wbg_stack_0ed75d68575b0f3c: (out, i) => {
            const ptr = putString(String(get(i).stack));
            dv().setInt32(out + 4, lastLength, true);
            dv().setInt32(out + 0, ptr, true);
        },
        __wbg_static_accessor_GLOBAL_88a902d13a557d07: () => add(globalThis),
        __wbg_static_accessor_GLOBAL_THIS_56578be7e9f832b0: () => add(globalThis),
        __wbg_static_accessor_SELF_37c5d418e4bf5819: () => 0,
        __wbg_static_accessor_WINDOW_5de37043a91a9c40: () => 0,
        __wbg_subarray_aa9065fa9dc5df96: (i, start, end) => add(get(i).subarray(start >>> 0, end >>> 0)),
        __wbg_value_cd1ffa7b1ab794f1: (i) => add(get(i).value),
        __wbg_versions_c01dfd4722a88165: (i) => add(get(i).versions),
        // A device-list entry built by the module for a check this client does not make.
        __wbg_zprototrustcompaniondevice_new: (ptr) => add({ __wbg_ptr: ptr }),
        __wbindgen_as_number: (i) => +get(i),
        __wbindgen_bigint_from_u64: (value) => add(BigInt.asUintN(64, value)),
        __wbindgen_bigint_get_as_i64: (out, i) => {
            const value = get(i);
            const big = typeof value === "bigint" ? value : undefined;
            dv().setBigInt64(out + 8, isNil(big) ? 0n : big, true);
            dv().setInt32(out + 0, !isNil(big), true);
        },
        __wbindgen_boolean_get: (i) => {
            const value = get(i);
            return typeof value === "boolean" ? (value ? 1 : 0) : 2;
        },
        __wbindgen_debug_string: (out, i) => {
            const ptr = putString(String(get(i)));
            dv().setInt32(out + 4, lastLength, true);
            dv().setInt32(out + 0, ptr, true);
        },
        __wbindgen_error_new: (ptr, len) => add(new Error(readString(ptr, len))),
        __wbindgen_in: (key, target) => get(key) in get(target),
        __wbindgen_is_bigint: (i) => typeof get(i) === "bigint",
        __wbindgen_is_function: (i) => typeof get(i) === "function",
        __wbindgen_is_object: (i) => typeof get(i) === "object" && get(i) !== null,
        __wbindgen_is_string: (i) => typeof get(i) === "string",
        __wbindgen_is_undefined: (i) => get(i) === undefined,
        __wbindgen_jsval_eq: (a, b) => get(a) === get(b),
        __wbindgen_jsval_loose_eq: (a, b) => get(a) == get(b), // eslint-disable-line eqeqeq
        __wbindgen_memory: () => add(wasm.memory),
        __wbindgen_number_get: (out, i) => {
            const value = get(i);
            const number = typeof value === "number" ? value : undefined;
            dv().setFloat64(out + 8, isNil(number) ? 0 : number, true);
            dv().setInt32(out + 0, !isNil(number), true);
        },
        __wbindgen_number_new: (value) => add(value),
        __wbindgen_object_clone_ref: (i) => add(get(i)),
        __wbindgen_object_drop_ref: (i) => {
            take(i);
        },
        __wbindgen_string_get: (out, i) => {
            const value = get(i);
            const text = typeof value === "string" ? value : undefined;
            const ptr = isNil(text) ? 0 : putString(text);
            dv().setInt32(out + 4, isNil(text) ? 0 : lastLength, true);
            dv().setInt32(out + 0, ptr, true);
        },
        __wbindgen_string_new: (ptr, len) => add(readString(ptr, len)),
        __wbindgen_throw: (ptr, len) => {
            throw new Error(readString(ptr, len));
        },
    };

    const { instance } = await WebAssembly.instantiate(wasmBytes, { wbg });
    wasm = instance.exports;
    bytes = null;
    view = null;

    /** Call an export that answers `Result<T, Error>` through a 16-byte slot; returns the slot's first word. */
    const withSlot = (body) => {
        const slot = wasm.__wbindgen_add_to_stack_pointer(-16);
        try {
            return body(slot);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    };
    const word = (slot, index) => dv().getInt32(slot + index * 4, true);
    const takeBytes = (ptr, len) => {
        const copy = readBytes(ptr, len).slice();
        wasm.__wbindgen_export_1(ptr, len, 1);
        return copy;
    };
    /** A getter that answers a byte array through the slot. */
    const bytesGetter = (exportName, handle) =>
        withSlot((slot) => {
            wasm[exportName](slot, handle);
            return takeBytes(word(slot, 0), word(slot, 1));
        });

    const generateIdentity = () =>
        withSlot((slot) => {
            wasm.zprotoEd25519GenerateKeyPair(slot);
            if (word(slot, 2)) throw failure(take(word(slot, 1)));
            const handle = word(slot, 0);
            const publicKey = bytesGetter("zprotoed25519keypair_publicKey", handle);
            const privateKey = bytesGetter("zprotoed25519keypair_privateKey", handle);
            wasm.__wbg_zprotoed25519keypair_free(handle, 0);
            return { publicKey, privateKey };
        });

    const generateLinkingSecret = () =>
        withSlot((slot) => {
            wasm.zprotoTrustGenerateLinkingSecretKey(slot);
            if (word(slot, 2)) throw failure(take(word(slot, 1)));
            const handle = word(slot, 0);
            // The module has one body for this getter and the device-list-bytes one, and exports it under that name.
            const secret = bytesGetter("zprototrustdevicelistbytes_deviceListBytes", handle);
            wasm.__wbg_zprototrustlinkingsecretkey_free(handle, 0);
            return secret;
        });

    const generateLinkingQr = ({ publicKey, secret, qrToken, timestamp, platform = TRUST_PLATFORM_WEB, relinkId }) =>
        withSlot((slot) => {
            let ptr = 0;
            let len = 0;
            try {
                const keyPtr = putBytes(publicKey);
                const keyLen = lastLength;
                const secretPtr = isNil(secret) ? 0 : putBytes(secret);
                const secretLen = lastLength;
                const tokenPtr = putString(qrToken);
                const tokenLen = lastLength;
                const relinkPtr = isNil(relinkId) ? 0 : putBytes(relinkId);
                const relinkLen = lastLength;
                wasm.zprotoTrustGenerateLinkingQr(
                    slot,
                    keyPtr,
                    keyLen,
                    secretPtr,
                    secretLen,
                    tokenPtr,
                    tokenLen,
                    BigInt(timestamp),
                    platform,
                    relinkPtr,
                    relinkLen,
                );
                ptr = word(slot, 0);
                len = word(slot, 1);
                if (word(slot, 3)) {
                    const reason = take(word(slot, 2));
                    ptr = 0;
                    len = 0;
                    throw failure(reason);
                }
                return readString(ptr, len);
            } finally {
                wasm.__wbindgen_export_1(ptr, len, 1);
            }
        });

    const createLinkingProof = ({
        publicKey,
        privateKey,
        secret,
        primaryLinkingData,
        linkingHmac,
        platform = TRUST_PLATFORM_WEB,
    }) =>
        withSlot((slot) => {
            const arrays = [publicKey, privateKey, secret, primaryLinkingData, linkingHmac].map((array) => {
                const ptr = putBytes(array);
                return [ptr, lastLength];
            });
            wasm.zprotoTrustCreateCompanionLinkingProof(slot, ...arrays.flat(), platform);
            if (word(slot, 2)) throw failure(take(word(slot, 1)));
            const handle = word(slot, 0);
            try {
                const linkId = BigInt.asUintN(64, wasm.zprototrustcheckedexpirationresult_remainingTime(handle));
                const masterId = withSlot((out) => {
                    wasm.zprototrustcompanionlinkingdata_masterId(out, handle);
                    const text = readString(word(out, 0), word(out, 1));
                    wasm.__wbindgen_export_1(word(out, 0), word(out, 1), 1);
                    return text;
                });
                return {
                    linkId: linkId.toString(),
                    masterId,
                    companionId: wasm.zprototrustcompanionlinkingdata_companionId(handle),
                    linkingTimestamp: Number(
                        BigInt.asUintN(64, wasm.zprototrustcompanionlinkingdata_linkingTimestamp(handle)),
                    ),
                    primaryPublicIdentityKey: bytesGetter(
                        "zprototrustcompanionlinkingdata_primaryPublicIdentityKey",
                        handle,
                    ),
                    linkingMetadata: bytesGetter("zprototrustcompanionlinkingdata_linkingMetadata", handle),
                    accountSignature: bytesGetter("zprototrustcompanionlinkingdata_accountSignature", handle),
                    deviceSignature: bytesGetter("zprototrustcompanionlinkingdata_deviceSignature", handle),
                };
            } finally {
                wasm.__wbg_zprototrustcompanionlinkingdata_free(handle, 0);
            }
        });

    const getRelinkId = ({ primaryKey, publicKey, secret, linkingTimestamp }) =>
        withSlot((slot) => {
            const arrays = [primaryKey, publicKey, secret].map((array) => {
                const ptr = putBytes(array);
                return [ptr, lastLength];
            });
            wasm.zprotoTrustGetRelinkId(slot, ...arrays.flat(), BigInt(linkingTimestamp));
            if (word(slot, 3)) throw failure(take(word(slot, 2)));
            return takeBytes(word(slot, 0), word(slot, 1));
        });

    return { generateIdentity, generateLinkingSecret, generateLinkingQr, createLinkingProof, getRelinkId };
}
