/**
 * `oa follower`, `oa userfield`, `oa tag`, `oa form`, `oa purchase`: users, user fields, tags, Zalo Ads forms and
 * OA product purchases (per Zalo's OA docs, "Quản lý" section). Requests are built in src/core/oa/users.js.
 */

import {
    getFollowerInfo,
    getFollowers,
    getAllFollowers,
    updateFollowerInfo,
    deleteFollowerInfo,
    getFollowerCustomInfo,
    updateFollowerCustomInfo,
    listUserFields,
    createUserField,
    updateUserField,
    deleteUserField,
    getTags,
    assignTag,
    removeTag,
    removeFollowerFromTag,
    getAdsForm,
    getAllAdsForm,
    createPurchaseOrder,
    confirmPurchaseOrder,
    FOLLOWER_LIST_LIMITS,
    ADS_FORM_LIMITS,
    USER_FIELD_DATA_TYPES,
    USER_FIELD_DATETIME_FORMATS,
} from "../../core/oa/users.js";
import { guardSubcommand } from "../../core/confirm-guard.js";
import { readJsonInput } from "../../utils/json-input.js";
import { success, error, info, warning, output } from "../../utils/output.js";

const OA_ID = ["--oa-id <id>", "OA identifier", "default"];

/** "a,b , c" → ["a","b","c"]; undefined stays undefined. */
function list(text) {
    if (text === undefined) return undefined;
    return String(text)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}

/** A user's name as shown: the OA's alias first, then the Zalo display name. */
function shownName(d) {
    if (d.user_alias && d.display_name && d.user_alias !== d.display_name) {
        return `${d.user_alias} (${d.display_name})`;
    }
    return d.user_alias || d.display_name || "N/A";
}

/**
 * The human lines of `oa follower info` (fields as `v3.0/oa/user/detail` returns them).
 * @param {object} d - the answer's `data`
 * @returns {string[]}
 */
export function describeFollower(d = {}) {
    const lines = [`Name: ${shownName(d)}`];
    if (d.user_id) lines.push(`User ID: ${d.user_id}`);
    if (d.user_id_by_app) lines.push(`App user ID: ${d.user_id_by_app}`);
    if (d.user_external_id) lines.push(`External ID: ${d.user_external_id}`);
    if (typeof d.user_is_follower === "boolean") lines.push(`Follows the OA: ${d.user_is_follower ? "yes" : "no"}`);
    if (d.user_last_interaction_date) lines.push(`Last interaction: ${d.user_last_interaction_date}`);
    if (typeof d.is_sensitive === "boolean" && d.is_sensitive) lines.push("Under 18: yes");
    const tags = d.tags_and_notes_info?.tag_names || [];
    if (tags.length) lines.push(`Tags: ${tags.join(", ")}`);
    const notes = (d.tags_and_notes_info?.notes || []).filter(Boolean);
    if (notes.length) lines.push(`Notes: ${notes.join(" | ")}`);
    const shared = d.shared_info && typeof d.shared_info === "object" ? d.shared_info : {};
    for (const [k, v] of Object.entries(shared)) {
        if (v !== "" && v !== null && v !== undefined) lines.push(`Shared ${k}: ${v}`);
    }
    return lines;
}

/**
 * The `oa follower update` fields from its flags and `--data`, in the shape buildFollowerUpdate takes (flags win
 * over the same field in `--data`).
 * @param {object} opts - the command's options
 * @returns {object}
 */
export function followerUpdateFields(opts) {
    const base = opts.data === undefined ? {} : readJsonInput(opts.data, "--data");
    if (base === null || typeof base !== "object" || Array.isArray(base)) {
        throw new TypeError("--data must be a JSON object");
    }
    const shared = { ...(base.shared_info || {}) };
    const fromFlags = {
        name: opts.name,
        phone: opts.phone,
        address: opts.address,
        city_id: opts.cityId,
        district_id: opts.districtId,
        user_dob: opts.dob,
    };
    for (const [k, v] of Object.entries(fromFlags)) if (v !== undefined) shared[k] = v;
    const fields = { ...base };
    delete fields.shared_info;
    if (Object.keys(shared).length) fields.shared_info = shared;
    if (opts.alias !== undefined) fields.user_alias = opts.alias;
    if (opts.externalId !== undefined) fields.user_external_id = opts.externalId;
    return fields;
}

/** The `isFollower` filter from `--followers-only` / `--non-followers`. */
function followerFilter(opts) {
    if (opts.followersOnly && opts.nonFollowers) {
        throw new RangeError("--followers-only and --non-followers cannot be combined");
    }
    if (opts.followersOnly) return true;
    if (opts.nonFollowers) return false;
    return undefined;
}

/**
 * Register `oa follower`, `oa userfield`, `oa tag`, `oa form` and `oa purchase` on the `oa` command.
 * @param {import("commander").Command} oa
 */
export function registerUsersCommands(oa) {
    const json = () => oa.parent?.opts().json;

    /** Run an action, reporting a thrown error through error() (exit 1). */
    const run =
        (fn) =>
        async (...args) => {
            try {
                await fn(...args);
            } catch (e) {
                error(e.message);
            }
        };

    // ─── oa follower ─────────────────────────────────────────────────

    const follower = oa.command("follower").description("OA users: details, list, update, custom info");

    follower
        .command("info <user-id>")
        .description("A user's details: name, alias, follow status, last interaction, tags, shared info")
        .option(...OA_ID)
        .action(
            run(async (userId, opts) => {
                const result = await getFollowerInfo(userId, opts.oaId);
                output(result, json(), () => describeFollower(result.data || {}).forEach((l) => info(l)));
            }),
        );

    follower
        .command("list")
        .description(
            `List user ids (${FOLLOWER_LIST_LIMITS.maxCount} per page, offset up to ${FOLLOWER_LIST_LIMITS.maxOffset}: ` +
                "at most 10,000 users); `oa follower info` gives a user's details",
        )
        .option("--offset <n>", `First user to return (0-${FOLLOWER_LIST_LIMITS.maxOffset})`, "0")
        .option("--count <n>", `Users per page (1-${FOLLOWER_LIST_LIMITS.maxCount})`, "50")
        .option("--tag <name>", "Only users with this tag")
        .option(
            "--last-interaction <period>",
            "Only users who last interacted in TODAY, YESTERDAY, L7D, L30D or YYYY_MM_DD:YYYY_MM_DD",
        )
        .option("--followers-only", "Only users who follow the OA")
        .option("--non-followers", "Only users who do not follow the OA")
        .option("--all", "Walk every page from --offset (50 at a time)")
        .option(...OA_ID)
        .action(
            run(async (opts) => {
                const filter = {
                    offset: opts.offset,
                    count: opts.count,
                    tagName: opts.tag,
                    lastInteraction: opts.lastInteraction,
                    isFollower: followerFilter(opts),
                };
                if (opts.all) {
                    const all = await getAllFollowers(filter, opts.oaId);
                    output(all, json(), () => {
                        info(`Users: ${all.users.length} of ${all.total}`);
                        all.users.forEach((u) => console.log(`  - ${u.user_id}`));
                        if (all.truncated) warning("Zalo lists at most 10,000 users; narrow the filters for the rest");
                    });
                    return;
                }
                const result = await getFollowers(filter, opts.oaId);
                output(result, json(), () => {
                    const d = result.data || {};
                    const users = Array.isArray(d.users) ? d.users : [];
                    info(`Users: ${users.length} of ${d.total ?? users.length} (offset ${d.offset ?? opts.offset})`);
                    users.forEach((u) => console.log(`  - ${u.user_id}`));
                });
            }),
        );

    follower
        .command("update <user-id>")
        .description(
            "Update what the OA stores about a user: shared info (name, phone, address, city/district id, birth date), " +
                "alias, external id",
        )
        .option("--name <name>", "shared_info.name")
        .option("--phone <phone>", "shared_info.phone")
        .option("--address <address>", "shared_info.address")
        .option("--city-id <id>", "shared_info.city_id (Vietnam administrative unit code)")
        .option("--district-id <id>", "shared_info.district_id (Vietnam administrative unit code)")
        .option("--dob <dd/MM/yyyy>", "shared_info.user_dob (from 01/01/1970)")
        .option("--alias <alias>", "user_alias")
        .option("--external-id <id>", "user_external_id (your own id for the user; one user per id)")
        .option(
            "--data <json>",
            'The body as JSON, e.g. \'{"shared_info":{"name":"..."},"user_alias":"..."}\' (flags override it)',
        )
        .option(...OA_ID)
        .action(
            run(async (userId, opts) => {
                const result = await updateFollowerInfo(userId, followerUpdateFields(opts), opts.oaId);
                output(result, json(), () => success(`User ${userId} updated`));
            }),
        );

    follower
        .command("delete-info <user-id>")
        .description("Delete the information the OA stores about a user (the user's Zalo account is not changed)")
        .option(...OA_ID)
        .action(
            run(async (userId, opts) => {
                const result = await deleteFollowerInfo(userId, opts.oaId);
                output(result, json(), () => success(`Stored information about user ${userId} deleted`));
            }),
        );

    follower
        .command("custom-info <user-id>")
        .description("A user's custom info (fields from `oa userfield list`; every value comes back as a string)")
        .option("--fields <keys>", "Comma-separated field keys to return (default: all; a table field by its key)")
        .option(...OA_ID)
        .action(
            run(async (userId, opts) => {
                const result = await getFollowerCustomInfo(userId, list(opts.fields), opts.oaId);
                output(result, json(), () => {
                    const d = result.data || {};
                    for (const k of ["user_id", "name", "phone", "user_dob", "gender", "user_external_id"]) {
                        if (d[k]) info(`${k}: ${d[k]}`);
                    }
                    if (d.full_address) info(`full_address: ${JSON.stringify(d.full_address)}`);
                    for (const [k, v] of Object.entries(d.custom_info || {})) {
                        info(`${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
                    }
                });
            }),
        );

    follower
        .command("custom-update <user-id> <json>")
        .description(
            "Update a user's custom info. JSON fields: name, phone, user_dob (dd/MM/yyyy), gender (Nam|Nữ|Khác), " +
                "full_address {user_city_id, user_ward_id, user_address}, user_external_id, custom_info {<key>: value}",
        )
        .option(...OA_ID)
        .action(
            run(async (userId, text, opts) => {
                const result = await updateFollowerCustomInfo(userId, readJsonInput(text, "the JSON"), opts.oaId);
                output(result, json(), () => success(`Custom info of user ${userId} updated`));
            }),
        );

    guardSubcommand(follower, "delete-info", "oa.follower.deleteInfo", {
        target: (userId, opts) => ({ userId, oaId: opts.oaId }),
    });

    // ─── oa userfield ────────────────────────────────────────────────

    const userfield = oa.command("userfield").description("The OA's user field definitions (system and custom)");

    userfield
        .command("list")
        .description("List the user fields")
        .option("--type <type>", "Only system or oa_custom fields")
        .option("--fields <keys>", "Comma-separated keys to return")
        .option(...OA_ID)
        .action(
            run(async (opts) => {
                const result = await listUserFields({ fieldType: opts.type, fields: list(opts.fields) }, opts.oaId);
                output(result, json(), () => {
                    const fields = Array.isArray(result.data?.fields) ? result.data.fields : [];
                    info(`User fields (${fields.length}):`);
                    for (const f of fields) {
                        console.log(`  - ${f.key}: ${f.name} (${f.data_type}, ${f.field_type}, ${f.status})`);
                    }
                });
            }),
        );

    userfield
        .command("create <key> <name>")
        .description("Create a custom user field (its key and data type cannot change afterwards)")
        .requiredOption("--type <data-type>", `Data type: ${USER_FIELD_DATA_TYPES.join(", ")}`)
        .option("--description <text>", "Description")
        .option("--status <status>", "active (default) or inactive")
        .option("--format <format>", `Datetime display format: ${USER_FIELD_DATETIME_FORMATS.join(", ")}`)
        .option(
            "--table-fields <json>",
            'A table field\'s columns (at most 5), e.g. \'[{"key":"paid","data_type":"boolean"}]\'',
        )
        .option(...OA_ID)
        .action(
            run(async (key, name, opts) => {
                const field = { key, name, data_type: opts.type };
                if (opts.description !== undefined) field.description = opts.description;
                if (opts.status !== undefined) field.status = opts.status;
                if (opts.format !== undefined) field.additional_format = opts.format;
                if (opts.tableFields !== undefined) {
                    field.additional_fields = readJsonInput(opts.tableFields, "--table-fields");
                }
                const result = await createUserField(field, opts.oaId);
                output(result, json(), () => success(`User field "${key}" created`));
            }),
        );

    userfield
        .command("update <key>")
        .description("Update a user field's name, description, status, datetime format, or add table columns")
        .option("--name <name>", "New name")
        .option("--description <text>", "New description")
        .option("--status <status>", "active or inactive (not for system fields)")
        .option("--format <format>", "New datetime display format")
        .option("--table-fields <json>", "Table columns to add (existing ones cannot be removed; at most 5 in all)")
        .option(...OA_ID)
        .action(
            run(async (key, opts) => {
                const field = { key };
                if (opts.name !== undefined) field.name = opts.name;
                if (opts.description !== undefined) field.description = opts.description;
                if (opts.status !== undefined) field.status = opts.status;
                if (opts.format !== undefined) field.additional_format = opts.format;
                if (opts.tableFields !== undefined) {
                    field.additional_fields = readJsonInput(opts.tableFields, "--table-fields");
                }
                const result = await updateUserField(field, opts.oaId);
                output(result, json(), () => success(`User field "${key}" updated`));
            }),
        );

    userfield
        .command("delete <key>")
        .description("Delete a custom user field and every user's value in it (system fields cannot be deleted)")
        .option(...OA_ID)
        .action(
            run(async (key, opts) => {
                const result = await deleteUserField(key, opts.oaId);
                output(result, json(), () => success(`User field "${key}" deleted`));
            }),
        );

    guardSubcommand(userfield, "delete", "oa.userfield.delete", {
        target: (key, opts) => ({ fieldId: key, oaId: opts.oaId }),
    });

    // ─── oa tag ──────────────────────────────────────────────────────

    const tag = oa.command("tag").description("The OA's user tags");

    tag.command("list")
        .description("List the OA's tags")
        .option(...OA_ID)
        .action(
            run(async (opts) => {
                const result = await getTags(opts.oaId);
                output(result, json(), () => {
                    const tags = Array.isArray(result.data) ? result.data : [];
                    info(`Tags (${tags.length}):`);
                    tags.forEach((t) => console.log(`  - ${t}`));
                });
            }),
        );

    tag.command("assign <user-id> <tag-name>")
        .description("Tag a user (a tag that does not exist yet is created)")
        .option(...OA_ID)
        .action(
            run(async (userId, tagName, opts) => {
                const result = await assignTag(userId, tagName, opts.oaId);
                output(result, json(), () => success(`Tag "${tagName}" assigned to user ${userId}`));
            }),
        );

    tag.command("untag <user-id> <tag-name>")
        .description("Remove a tag from one user")
        .option(...OA_ID)
        .action(
            run(async (userId, tagName, opts) => {
                const result = await removeFollowerFromTag(userId, tagName, opts.oaId);
                output(result, json(), () => success(`Tag "${tagName}" removed from user ${userId}`));
            }),
        );

    tag.command("remove <tag-name>")
        .description("Delete a tag, untagging every user")
        .option(...OA_ID)
        .action(
            run(async (tagName, opts) => {
                const result = await removeTag(tagName, opts.oaId);
                output(result, json(), () => success(`Tag "${tagName}" deleted`));
            }),
        );

    guardSubcommand(tag, "remove", "oa.tag.remove", {
        target: (tagName, opts) => ({ tagName, oaId: opts.oaId }),
    });

    // ─── oa form ─────────────────────────────────────────────────────

    const form = oa.command("form").description("Zalo Ads lead forms");

    form.command("get <form-id>")
        .description("A Zalo Ads form's questions and the responses submitted in a window of at most 30 days")
        .requiredOption("--from <time>", "Window start: Unix seconds or a date (e.g. 2026-11-01)")
        .requiredOption("--to <time>", "Window end: Unix seconds or a date, at most 30 days after --from")
        .option("--offset <n>", "First response to return", "0")
        .option("--limit <n>", `Responses per page (1-${ADS_FORM_LIMITS.maxLimit})`, String(ADS_FORM_LIMITS.maxLimit))
        .option("--all", `Walk every page from --offset (${ADS_FORM_LIMITS.maxLimit} at a time)`)
        .option(...OA_ID)
        .action(
            run(async (formId, opts) => {
                const q = { formId, from: opts.from, to: opts.to, offset: opts.offset, limit: opts.limit };
                const result = opts.all ? await getAllAdsForm(q, opts.oaId) : await getAdsForm(q, opts.oaId);
                output(result, json(), () => {
                    const d = opts.all ? result : result.data || {};
                    const questions = Array.isArray(d.questions) ? d.questions : [];
                    const responses = Array.isArray(d.responses) ? d.responses : [];
                    const titles = new Map(questions.map((x) => [String(x.questionId), x.title]));
                    info(`Responses: ${responses.length} of ${d.total ?? responses.length}`);
                    for (const r of responses) {
                        const when = Number(r.submitTime) ? new Date(Number(r.submitTime) * 1000).toISOString() : "";
                        console.log(`  - lead ${r.leadId} ${when}${r.adId ? ` (ad ${r.adId})` : ""}`);
                        for (const a of r.answers || []) {
                            const title = titles.get(String(a.questionId)) ?? a.questionId;
                            console.log(`      ${title}: ${(a.responses || []).join("; ")}`);
                        }
                    }
                });
            }),
        );

    // ─── oa purchase ─────────────────────────────────────────────────

    const purchase = oa
        .command("purchase")
        .description("Buy OA products (packages, GMF quota): create an order, then confirm it within 5 minutes");

    purchase
        .command("create-order")
        .description(
            "Create an order (no charge yet): shows the price and the one-time token confirm-order needs " +
                "(valid 5 minutes; orders can be created from 00:01 to 23:54)",
        )
        .option("--product-id <id>", "The product to buy (product ids are listed in Zalo's OA docs)")
        .option("--redeem-code <code>", "A gift code, instead of --product-id")
        .option("--voucher <code>", "A discount voucher code")
        .option("--beneficiary <who>", "OA or APP: who receives the product", "OA")
        .option(...OA_ID)
        .action(
            run(async (opts) => {
                const result = await createPurchaseOrder(
                    {
                        beneficiary: opts.beneficiary,
                        productId: opts.productId,
                        redeemCode: opts.redeemCode,
                        voucherCode: opts.voucher,
                    },
                    opts.oaId,
                );
                output(result, json(), () => {
                    const d = result.data || {};
                    success(`Order ${d.order_id} created: ${d.product_name ?? d.product_id}`);
                    info(`Amount: ${d.amount}; after discount: ${d.final_amount}`);
                    info(
                        `To pay (within 5 minutes): oa purchase confirm-order ${d.order_id} ${d.verified_token} --yes`,
                    );
                });
            }),
        );

    purchase
        .command("confirm-order <order-id> <verified-token>")
        .description("Pay an order created by create-order: the product is bought and the ZCA account charged")
        .option(...OA_ID)
        .action(
            run(async (orderId, token, opts) => {
                const result = await confirmPurchaseOrder(orderId, token, opts.oaId);
                output(result, json(), () => {
                    const d = result.data || {};
                    success(`Order ${d.order_id ?? orderId} paid: ${d.product_name ?? d.product_id ?? ""}`);
                    if (d.final_amount !== undefined) info(`Charged: ${d.final_amount}`);
                });
            }),
        );

    guardSubcommand(purchase, "confirm-order", "oa.purchase", {
        target: (orderId, _token, opts) => ({ orderId, oaId: opts.oaId }),
    });
}
