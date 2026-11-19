/**
 * What a media file really is, from its own bytes.
 *
 * A file server's `Content-Type`, a URL's extension and a message's `ext` are claims; the first bytes of the file are
 * the fact. Every received file is named and typed by its bytes here, and only a file whose bytes say nothing falls
 * back to what was declared. Written from the published format specifications (JPEG, PNG, GIF, WebP/RIFF, JPEG XL,
 * ISO base media file format with the HEIF/AVIF brands, MPEG audio and ADTS, Ogg, FLAC, AMR, WAVE, Matroska/WebM,
 * PDF); nothing here decodes a picture or a sound, it only reads signatures and, for MP4/MOV, the track list.
 *
 * {@link sniffMedia} takes a buffer (a download in memory) or a reader over a sealed file, so a cached file is typed
 * by decrypting its head (and, for an MP4 whose index sits at the end, the few boxes it needs), never the whole file.
 */

/** Bytes of a file's head enough for every signature here (the ISO/Matroska track scan reads more on its own). */
export const SNIFF_HEAD_BYTES = 4100;

/** How far into a Matroska/WebM file its track list is looked for. */
const MATROSKA_SCAN_BYTES = 65536;
/** Most ISO boxes visited in one file (a damaged or hostile file cannot keep the walk going). */
const MAX_BOXES = 4096;

const ascii = (b, start, end) => (b.length >= end ? b.toString("latin1", start, end) : "");
const startsWith = (b, bytes, at = 0) => b.length >= at + bytes.length && bytes.every((x, i) => b[at + i] === x);

/** HEIF brands (ISO/IEC 23008-12) and the type each stands for. */
const HEIF_BRANDS = {
    heic: { mime: "image/heic", ext: "heic" },
    heix: { mime: "image/heic", ext: "heic" },
    heim: { mime: "image/heic", ext: "heic" },
    heis: { mime: "image/heic", ext: "heic" },
    hevc: { mime: "image/heic-sequence", ext: "heics", animated: true },
    hevx: { mime: "image/heic-sequence", ext: "heics", animated: true },
    hevm: { mime: "image/heic-sequence", ext: "heics", animated: true },
    hevs: { mime: "image/heic-sequence", ext: "heics", animated: true },
    avif: { mime: "image/avif", ext: "avif" },
    avis: { mime: "image/avif", ext: "avif", animated: true },
    mif1: { mime: "image/heif", ext: "heif" },
    mif2: { mime: "image/heif", ext: "heif" },
    msf1: { mime: "image/heif-sequence", ext: "heifs", animated: true },
};
/** The order a structural brand (mif1/msf1) is refined by its compatible brands: the codec brands first. */
const HEIF_PRECEDENCE = ["avis", "avif", "hevc", "hevx", "hevm", "hevs", "heic", "heix", "heim", "heis", "msf1"];

/** Sample entry codes of a video track, and the codec each is. */
const VIDEO_CODECS = {
    avc1: "h264",
    avc2: "h264",
    avc3: "h264",
    avc4: "h264",
    hvc1: "hevc",
    hev1: "hevc",
    dvh1: "hevc",
    dvhe: "hevc",
    av01: "av1",
    vp08: "vp8",
    vp09: "vp9",
    mp4v: "mpeg4",
    s263: "h263",
    h263: "h263",
    jpeg: "mjpeg",
    mjpa: "mjpeg",
    apch: "prores",
    apcn: "prores",
    apcs: "prores",
    apco: "prores",
    ap4h: "prores",
};
/** Sample entry codes of an audio track, and the codec each is. */
const AUDIO_CODECS = {
    mp4a: "aac",
    Opus: "opus",
    fLaC: "flac",
    "ac-3": "ac3",
    "ec-3": "eac3",
    alac: "alac",
    samr: "amr",
    sawb: "amr-wb",
    ".mp3": "mp3",
    lpcm: "pcm",
    sowt: "pcm",
    twos: "pcm",
};

/**
 * Whether `b` at `at` is an MPEG-1/2/2.5 audio frame header (layer I, II or III) with valid rate fields.
 *
 * @param {Buffer} b
 * @param {number} [at]
 */
function isMpegAudioFrame(b, at = 0) {
    if (b.length < at + 4 || b[at] !== 0xff || (b[at + 1] & 0xe0) !== 0xe0) return false;
    const version = (b[at + 1] >> 3) & 3;
    const layer = (b[at + 1] >> 1) & 3;
    const bitrate = b[at + 2] >> 4;
    const rate = (b[at + 2] >> 2) & 3;
    return version !== 1 && layer !== 0 && bitrate !== 0xf && rate !== 3;
}

/** Whether `b` at `at` is an AAC ADTS frame header (sync, layer 0, a valid sampling index). */
function isAdtsFrame(b, at = 0) {
    if (b.length < at + 7 || b[at] !== 0xff || (b[at + 1] & 0xf6) !== 0xf0) return false;
    return ((b[at + 2] >> 2) & 0xf) < 13;
}

/** The length of an ID3v2 tag at the start of `b` (header, body and footer), or 0 when there is none. */
function id3Length(b) {
    if (!startsWith(b, [0x49, 0x44, 0x33]) || b.length < 10) return 0;
    if ((b[6] | b[7] | b[8] | b[9]) & 0x80) return 0; // not a sync-safe size
    const size = (b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9];
    return 10 + size + (b[5] & 0x10 ? 10 : 0);
}

/**
 * The ISO base media brands of a file: its `ftyp` box's major brand and compatible brands. Null when the file does
 * not start with an `ftyp` box.
 *
 * @param {Buffer} b
 * @returns {{major: string, compatible: string[]}|null}
 */
export function isoBrands(b) {
    if (b.length < 12 || ascii(b, 4, 8) !== "ftyp") return null;
    const size = b.readUInt32BE(0);
    if (size < 16 && size !== 12) return null;
    const major = ascii(b, 8, 12);
    const compatible = [];
    for (let at = 16; at + 4 <= Math.min(size, b.length); at += 4) compatible.push(ascii(b, at, at + 4));
    return { major, compatible };
}

/**
 * The HEIF/AVIF type of a set of brands: the major brand when it names one, refined through the compatible brands
 * when it is only the structural `mif1`/`msf1` (an AVIF or HEIC file may carry `mif1` as its major brand).
 *
 * @param {{major: string, compatible: string[]}} brands
 * @returns {{mime: string, ext: string, animated?: boolean}|null}
 */
function heifType({ major, compatible }) {
    const all = new Set([major, ...compatible]);
    if (HEIF_BRANDS[major] && major !== "mif1" && major !== "mif2" && major !== "msf1") return HEIF_BRANDS[major];
    if (major === "mif1" || major === "mif2" || major === "msf1") {
        for (const brand of HEIF_PRECEDENCE) if (all.has(brand)) return HEIF_BRANDS[brand];
        return HEIF_BRANDS[major];
    }
    // A movie brand with an image brand among the compatible ones is a movie (an MP4 may list `mif1`); only a file
    // with no movie brand at all is taken for a picture by its compatible brands.
    return null;
}

/** The type of a movie or sound in the ISO family, by its brands alone (before its tracks are read). */
function isoMovieType({ major, compatible }) {
    const all = [major, ...compatible];
    if (major === "qt  ") return { mime: "video/quicktime", ext: "mov" };
    if (/^M4[ABP] $/.test(major)) return { mime: "audio/mp4", ext: "m4a" };
    if (major === "M4V " || major === "M4VH" || major === "M4VP") return { mime: "video/mp4", ext: "m4v" };
    if (/^3g2/.test(major)) return { mime: "video/3gpp2", ext: "3g2" };
    if (/^3g/.test(major)) return { mime: "video/3gpp", ext: "3gp" };
    if (major === "crx ") return null; // a camera raw file, not a movie
    if (!/^[\x20-\x7e]{4}$/.test(major)) return null;
    if (all.some((brand) => HEIF_BRANDS[brand]) && !all.some((x) => /^(iso|mp4|avc|qt  |dash|M4)/.test(x))) {
        return null;
    }
    return { mime: "video/mp4", ext: "mp4" };
}

/**
 * The sample entry codes of every track of an ISO base media file (`moov/trak/mdia/minf/stbl/stsd`), read through
 * `read`: only box headers and the small `stsd` boxes are read, wherever the `moov` box sits.
 *
 * @param {(start: number, end: number) => Buffer} read - bytes [start, end) of the file (shorter at its end)
 * @param {number} size - the file's length
 * @returns {string[]} four-character codes, e.g. `["hvc1", "mp4a"]`
 */
export function isoSampleEntries(read, size) {
    const codes = [];
    let visited = 0;
    const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl"]);
    const walk = (start, end, depth) => {
        let at = start;
        while (at + 8 <= end && visited++ < MAX_BOXES) {
            const head = read(at, Math.min(end, at + 16));
            if (head.length < 8) return;
            let boxSize = head.readUInt32BE(0);
            const type = ascii(head, 4, 8);
            let headerSize = 8;
            if (boxSize === 1) {
                if (head.length < 16) return;
                const big = head.readBigUInt64BE(8);
                if (big > BigInt(Number.MAX_SAFE_INTEGER)) return;
                boxSize = Number(big);
                headerSize = 16;
            } else if (boxSize === 0) {
                boxSize = end - at;
            }
            if (boxSize < headerSize || at + boxSize > end) return;
            if (CONTAINERS.has(type) && depth < 6) {
                walk(at + headerSize, at + boxSize, depth + 1);
            } else if (type === "stsd" && boxSize <= 65536) {
                const box = read(at, at + boxSize);
                const count = box.length >= headerSize + 8 ? box.readUInt32BE(headerSize + 4) : 0;
                let entry = headerSize + 8;
                for (let i = 0; i < count && entry + 8 <= box.length; i++) {
                    const entrySize = box.readUInt32BE(entry);
                    codes.push(ascii(box, entry + 4, entry + 8));
                    if (entrySize < 8) break;
                    entry += entrySize;
                }
            }
            at += boxSize;
        }
    };
    walk(0, size, 0);
    return codes;
}

/** Refine an ISO movie type by its tracks: a file with sound and no picture is audio; name the codecs. */
function refineIsoMovie(type, codes) {
    const video = codes.map((c) => VIDEO_CODECS[c]).find(Boolean) ?? null;
    const audio = codes.map((c) => AUDIO_CODECS[c]).find(Boolean) ?? null;
    const out = { ...type };
    if (video) out.videoCodec = video;
    if (audio) out.audioCodec = audio;
    if (!video && audio && type.mime.startsWith("video/")) {
        out.mime = "audio/mp4";
        out.ext = "m4a";
    }
    if (video && type.mime === "audio/mp4") {
        out.mime = "video/mp4";
        out.ext = "mp4";
    }
    return out;
}

/** The first Ogg packet's codec: Opus, Vorbis, FLAC, Speex or Theora. */
function oggType(b) {
    const segments = b[26] ?? 0;
    const at = 27 + segments;
    const id = b.toString("latin1", at, at + 8);
    if (id === "OpusHead") return { mime: "audio/ogg", ext: "opus", audioCodec: "opus" };
    if (id.startsWith("\x01vorbis")) return { mime: "audio/ogg", ext: "ogg", audioCodec: "vorbis" };
    if (id.startsWith("\x7fFLAC")) return { mime: "audio/ogg", ext: "oga", audioCodec: "flac" };
    if (id.startsWith("Speex")) return { mime: "audio/ogg", ext: "spx", audioCodec: "speex" };
    if (id.startsWith("\x80theora")) return { mime: "video/ogg", ext: "ogv", videoCodec: "theora" };
    return { mime: "application/ogg", ext: "ogg" };
}

/** A Matroska/WebM file's type: its DocType, and audio when its tracks name only audio codecs. */
function matroskaType(b) {
    const text = b.toString("latin1");
    const webm = text.includes("webm");
    const videoId = /V_(VP8|VP9|AV1|MPEG4\/ISO\/AVC|MPEGH\/ISO\/HEVC|THEORA|MPEG|MS)/.exec(text);
    const audioId = /A_(OPUS|VORBIS|AAC|MPEG|FLAC|PCM|AC3)/.exec(text);
    const VIDEO = { VP8: "vp8", VP9: "vp9", AV1: "av1", "MPEG4/ISO/AVC": "h264", "MPEGH/ISO/HEVC": "hevc" };
    const out = webm ? { mime: "video/webm", ext: "webm" } : { mime: "video/x-matroska", ext: "mkv" };
    if (videoId) out.videoCodec = VIDEO[videoId[1]] ?? videoId[1].toLowerCase();
    if (audioId) out.audioCodec = audioId[1].toLowerCase();
    if (!videoId && audioId) {
        out.mime = webm ? "audio/webm" : "audio/x-matroska";
        out.ext = webm ? "weba" : "mka";
    }
    return out;
}

/**
 * The type a file's head says it is, by signature. No track scan: see {@link sniffMedia} for that.
 *
 * @param {Buffer|Uint8Array|null|undefined} input - the first bytes ({@link SNIFF_HEAD_BYTES} is enough)
 * @returns {{mime: string, ext: string, animated?: boolean, videoCodec?: string, audioCodec?: string}|null} null when
 *   the bytes match no format known here
 */
export function sniffMediaType(input) {
    if (!input || input.length < 2) return null;
    const b = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    // Pictures.
    if (startsWith(b, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", ext: "jpg" };
    if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
        // An animated PNG names an `acTL` chunk before its first `IDAT`; it is still image/png to every reader.
        const idat = b.indexOf("IDAT", 8, "latin1");
        const actl = b.indexOf("acTL", 8, "latin1");
        return actl > 0 && (idat < 0 || actl < idat)
            ? { mime: "image/png", ext: "png", animated: true }
            : { mime: "image/png", ext: "png" };
    }
    if (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a") return { mime: "image/gif", ext: "gif" };
    if (ascii(b, 0, 4) === "RIFF" && b.length >= 12) {
        const form = ascii(b, 8, 12);
        if (form === "WEBP") {
            const animated = ascii(b, 12, 16) === "VP8X" && b.length > 20 && (b[20] & 0x02) !== 0;
            return animated ? { mime: "image/webp", ext: "webp", animated: true } : { mime: "image/webp", ext: "webp" };
        }
        if (form === "WAVE") return { mime: "audio/wav", ext: "wav" };
        if (form === "AVI ") return { mime: "video/x-msvideo", ext: "avi" };
        return null;
    }
    if (startsWith(b, [0xff, 0x0a])) return { mime: "image/jxl", ext: "jxl" };
    if (startsWith(b, [0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a])) {
        return { mime: "image/jxl", ext: "jxl" };
    }
    // The ISO base media family: HEIF/HEIC/AVIF pictures, MP4/MOV/3GP movies, M4A sound.
    const brands = isoBrands(b);
    if (brands) return heifType(brands) ?? isoMovieType(brands);
    // Sound.
    if (ascii(b, 0, 9) === "#!AMR-WB\n") return { mime: "audio/amr-wb", ext: "awb", audioCodec: "amr-wb" };
    if (ascii(b, 0, 6) === "#!AMR\n") return { mime: "audio/amr", ext: "amr", audioCodec: "amr" };
    if (ascii(b, 0, 4) === "OggS" && b.length >= 36) return oggType(b);
    if (ascii(b, 0, 4) === "fLaC") return { mime: "audio/flac", ext: "flac", audioCodec: "flac" };
    const tag = id3Length(b);
    if (tag) {
        if (isAdtsFrame(b, tag)) return { mime: "audio/aac", ext: "aac", audioCodec: "aac" };
        return { mime: "audio/mpeg", ext: "mp3", audioCodec: "mp3" };
    }
    if (isAdtsFrame(b)) return { mime: "audio/aac", ext: "aac", audioCodec: "aac" };
    if (isMpegAudioFrame(b)) return { mime: "audio/mpeg", ext: "mp3", audioCodec: "mp3" };
    // Containers and documents.
    if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) return matroskaType(b);
    if (ascii(b, 0, 5) === "%PDF-") return { mime: "application/pdf", ext: "pdf" };
    return null;
}

/**
 * The type a whole file is, by its bytes: the head's signature, then for an MP4/MOV/3GP its tracks (which codec
 * the picture is, and whether it is only sound) and for an MP3 with a long ID3 tag the frame after it.
 *
 * @param {Buffer|{read: (start: number, end: number) => Buffer, size: number}} source - the bytes, or a reader of
 *   bytes [start, end) and the file's length (a sealed file: each read decrypts only the chunks it covers)
 * @returns {{mime: string, ext: string, animated?: boolean, videoCodec?: string, audioCodec?: string}|null}
 */
export function sniffMedia(source) {
    if (!source) return null;
    const isBuffer = Buffer.isBuffer(source) || source instanceof Uint8Array;
    const buf = isBuffer ? Buffer.from(source.buffer, source.byteOffset, source.byteLength) : null;
    const size = isBuffer ? buf.length : Number(source.size) || 0;
    const read = isBuffer
        ? (start, end) => buf.subarray(start, Math.min(end, buf.length))
        : (start, end) => (start >= size ? Buffer.alloc(0) : source.read(start, Math.min(end, size)));
    const firstScan = Math.min(size, Math.max(SNIFF_HEAD_BYTES, MATROSKA_SCAN_BYTES));
    const head = read(0, startsWith(read(0, 4), [0x1a, 0x45, 0xdf, 0xa3]) ? firstScan : SNIFF_HEAD_BYTES);
    const type = sniffMediaType(head);
    if (!type) return null;
    // An ID3 tag longer than the head (cover art) hides the first frame: look right after it.
    const tag = id3Length(head);
    if (type.audioCodec === "mp3" && tag > head.length && tag < size) {
        if (isAdtsFrame(read(tag, tag + 16))) return { mime: "audio/aac", ext: "aac", audioCodec: "aac" };
    }
    if (isoBrands(head) && !type.mime.startsWith("image/")) {
        return refineIsoMovie(type, isoSampleEntries(read, size));
    }
    return type;
}
