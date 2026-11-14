/**
 * The checks Zalo's ZBS docs set on a template body for "API Tạo Template" / "API Chỉnh sửa Template", applied
 * before anything is sent so a mistake costs no request out of the 100-a-day quota:
 *
 * - the body fields (`template_name` 10-60, `template_type` 1-5, `tag` 1-3 allowed for that type, `note` 1-400,
 *   `tracking_id` required, `params` with `name`/`type`/`sample_value`);
 * - which components each `template_type` takes in header/body/footer, and how many ("Quy định về số lượng và thứ
 *   tự các components theo từng loại template_type");
 * - each component's own limits ("Danh sách Components": TITLE, PARAGRAPH, OTP, TABLE, LOGO, IMAGES, BUTTONS,
 *   PAYMENT, VOUCHER, RATING), the BIN codes PAYMENT accepts ("Danh sách BIN CODE") and the param types.
 *
 * Every `<param>` used in the layout must be declared in `params`.
 */

/** template_type → name (docs: "Danh sách template_type"). */
export const TEMPLATE_TYPES = Object.freeze({
    1: "custom",
    2: "authentication (OTP)",
    3: "payment request",
    4: "voucher",
    5: "service rating",
});

/** tag → name (docs: "Tag mẫu tin"). */
export const TEMPLATE_TAGS = Object.freeze({ 1: "TRANSACTION", 2: "CUSTOMER_CARE", 3: "PROMOTION" });

/** template_type → the tags it may use. */
export const TAGS_BY_TYPE = Object.freeze({ 1: [1, 2, 3], 2: [1], 3: [1, 3], 4: [1, 2, 3], 5: [2] });

/** Param type → [name, maximum length of its value] (docs: "Danh sách param type"). */
export const PARAM_TYPES = Object.freeze({
    1: ["customer name", 30],
    2: ["phone number", 15],
    3: ["address", 200],
    4: ["code", 30],
    5: ["custom label", 30],
    6: ["transaction status", 30],
    7: ["contact information", 50],
    8: ["gender / title", 5],
    9: ["product / brand name", 200],
    10: ["quantity / amount", 20],
    11: ["time", 20],
    12: ["OTP", 10],
    13: ["URL", 200],
    14: ["currency (VND)", 12],
    15: ["bank transfer note", 90],
});

/** Button type → name (docs: "Danh sách button"). Type 6 is no longer accepted after 16/03/2026. */
export const BUTTON_TYPES = Object.freeze({
    1: "business page",
    2: "phone call",
    3: "OA profile",
    4: "the business's Zalo Mini App",
    5: "the business's app",
    6: "product distribution page (retired 16/03/2026)",
    7: "another web page / Zalo Mini App",
    8: "another business's app",
    9: "OA article or other Zalo resource",
    10: "copy",
    11: "pay now",
    12: "view details",
    13: "e-invoice lookup",
    14: "app download page",
});

/** BIN codes the PAYMENT component accepts (docs: "Danh sách BIN CODE"). */
export const BIN_CODES = Object.freeze({
    168999: "Cathay United",
    422589: "CIMB",
    458761: "HSBC",
    533948: "Citibank",
    546034: "CAKE",
    546035: "Ubank",
    668888: "KBank",
    796500: "DBSBank",
    801011: "Nonghyup",
    963369: "Liobank",
    963666: "BNP Paribas HCM",
    963668: "BNP Paribas HN",
    970400: "SaigonBank",
    970403: "Sacombank",
    970405: "Agribank",
    970406: "DongABank",
    970407: "Techcombank",
    970408: "GPBank",
    970409: "BacABank",
    970410: "Standard Chartered",
    970412: "PVcomBank",
    970414: "Oceanbank",
    970415: "VietinBank",
    970416: "ACB",
    970418: "BIDV",
    970419: "NCB",
    970421: "VRB",
    970422: "MBBank",
    970423: "TPBank",
    970424: "ShinhanBank",
    970425: "ABBANK",
    970426: "MSB",
    970427: "VietABank",
    970428: "NamABank",
    970429: "SCB",
    970430: "PGBank",
    970431: "Eximbank",
    970432: "VPBank",
    970433: "VietBank",
    970434: "IndovinaBank",
    970436: "Vietcombank",
    970437: "HDBank",
    970438: "BaoVietBank",
    970439: "PublicBank",
    970440: "SeABank",
    970441: "VIB",
    970442: "HongLeong",
    970443: "SHB",
    970444: "CBBank",
    970446: "COOPBANK",
    970448: "OCB",
    970449: "LienVietPostBank",
    970452: "KienLongBank",
    970454: "VietCapitalBank",
    970455: "IBKHN",
    970456: "IBKHCM",
    970457: "Woori",
    970458: "United Overseas",
    970462: "KookminHN",
    970463: "KookminHCM",
    970466: "Keb Hana HCM",
    970467: "Keb Hana HN",
});

/**
 * Which components each template_type takes, per section: `{ COMPONENT: [min, max] }`, plus `oneOf` (exactly one
 * of these) and `buttons` ([min, max] button items in the footer).
 */
const LAYOUT_RULES = Object.freeze({
    1: {
        header: { oneOf: ["LOGO", "IMAGES"] },
        body: { TITLE: [1, 1], PARAGRAPH: [0, 4], TABLE: [0, 1] },
        footer: { BUTTONS: [0, 1] },
        buttons: [0, 3],
        imagesNeedButton: true,
    },
    2: {
        header: { LOGO: [1, 1] },
        body: { OTP: [1, 1], PARAGRAPH: [1, 1] },
        footer: {},
        buttons: [0, 0],
    },
    3: {
        header: { LOGO: [1, 1] },
        body: { TITLE: [1, 1], PARAGRAPH: [0, 4], TABLE: [0, 1], PAYMENT: [1, 1] },
        footer: { BUTTONS: [0, 1] },
        buttons: [1, 3],
    },
    4: {
        header: { oneOf: ["LOGO", "IMAGES"] },
        body: { TITLE: [1, 1], PARAGRAPH: [0, 4], TABLE: [0, 1], VOUCHER: [1, 1] },
        footer: { BUTTONS: [0, 1] },
        buttons: [1, 3],
    },
    5: {
        header: { LOGO: [1, 1] },
        body: { TITLE: [1, 1], PARAGRAPH: [0, 1], RATING: [1, 1] },
        footer: { BUTTONS: [0, 1] },
        buttons: [0, 2],
    },
});

const PLACEHOLDER_RE = /<([^<>\s]+)>/g;

function len(s) {
    return [...String(s)].length;
}

function placeholders(s) {
    return [...String(s ?? "").matchAll(PLACEHOLDER_RE)].map((m) => m[1]);
}

/**
 * Check a template create/edit body against the docs. Returns the problems found (empty when it passes).
 *
 * @param {object} body - the request body (template_name, template_type, tag, layout, params, note, tracking_id)
 * @param {{ edit?: boolean }} [opts] - `edit` also requires `template_id`
 * @returns {string[]}
 */
export function checkTemplate(body, { edit = false } = {}) {
    const problems = [];
    const p = (msg) => problems.push(msg);
    if (!body || typeof body !== "object" || Array.isArray(body)) return ["the template must be a JSON object"];

    if (edit && (body.template_id === undefined || body.template_id === "")) p("template_id is required");
    if (typeof body.template_name !== "string") p("template_name is required (10-60 characters)");
    else if (len(body.template_name) < 10 || len(body.template_name) > 60) {
        p(`template_name must be 10-60 characters (it is ${len(body.template_name)})`);
    }
    const type = Number(body.template_type);
    if (!TEMPLATE_TYPES[type]) p("template_type must be 1-5 (1 custom, 2 OTP, 3 payment request, 4 voucher, 5 rating)");
    const tag = Number(body.tag);
    if (!TEMPLATE_TAGS[tag]) p("tag must be 1 (transaction), 2 (customer care) or 3 (promotion)");
    else if (TEMPLATE_TYPES[type] && !TAGS_BY_TYPE[type].includes(tag)) {
        p(`template_type ${type} (${TEMPLATE_TYPES[type]}) takes tag ${TAGS_BY_TYPE[type].join(" or ")}, not ${tag}`);
    }
    if (body.note !== undefined && (len(body.note) < 1 || len(body.note) > 400)) p("note must be 1-400 characters");
    if (body.tracking_id === undefined || body.tracking_id === null || body.tracking_id === "") {
        p("tracking_id is required");
    }

    // params
    const declared = new Map();
    if (body.params !== undefined && !Array.isArray(body.params)) p("params must be an array");
    for (const [i, param] of (Array.isArray(body.params) ? body.params : []).entries()) {
        const at = `params[${i}]`;
        if (!param || typeof param !== "object") {
            p(`${at} must be an object`);
            continue;
        }
        if (!param.name) p(`${at}.name is required`);
        const pt = PARAM_TYPES[Number(param.type)];
        if (!pt) p(`${at}.type must be 1-15 (see the param type list), not ${JSON.stringify(param.type)}`);
        if (param.sample_value === undefined || param.sample_value === "") p(`${at}.sample_value is required`);
        else if (pt && len(param.sample_value) > pt[1]) {
            p(`${at}.sample_value is longer than ${pt[1]} characters (type ${param.type}, ${pt[0]})`);
        }
        if (param.name) {
            if (declared.has(param.name)) p(`param "${param.name}" is declared twice`);
            declared.set(param.name, Number(param.type));
        }
    }

    // layout
    const layout = body.layout;
    if (!layout || typeof layout !== "object" || Array.isArray(layout)) {
        p("layout is required: { header, body, footer }, each { components: [...] }");
        return problems;
    }
    const used = [];
    const rules = LAYOUT_RULES[type];
    let buttonItems = 0;
    let hasImages = false;
    for (const section of ["header", "body", "footer"]) {
        const comps = layout[section]?.components ?? [];
        if (layout[section] !== undefined && !Array.isArray(layout[section]?.components)) {
            p(`layout.${section}.components must be an array`);
            continue;
        }
        const counts = {};
        for (const [i, comp] of comps.entries()) {
            const at = `layout.${section}.components[${i}]`;
            const keys = comp && typeof comp === "object" ? Object.keys(comp) : [];
            if (keys.length !== 1) {
                p(`${at} must hold exactly one component (e.g. { "TITLE": { ... } })`);
                continue;
            }
            const name = keys[0];
            counts[name] = (counts[name] || 0) + 1;
            checkComponent(name, comp[name], at, p, used);
            if (name === "BUTTONS") buttonItems += Array.isArray(comp[name]?.items) ? comp[name].items.length : 0;
            if (name === "IMAGES") hasImages = true;
        }
        if (!rules) continue;
        const rule = rules[section];
        if (rule.oneOf) {
            const n = rule.oneOf.reduce((a, c) => a + (counts[c] || 0), 0);
            if (n !== 1) p(`layout.${section} must hold exactly one of ${rule.oneOf.join(" or ")} (it has ${n})`);
            for (const c of Object.keys(counts)) {
                if (!rule.oneOf.includes(c)) p(`layout.${section} cannot hold ${c} in a template_type ${type}`);
            }
            continue;
        }
        for (const c of Object.keys(counts)) {
            if (!rule[c]) p(`layout.${section} cannot hold ${c} in a template_type ${type}`);
        }
        for (const [c, [min, max]] of Object.entries(rule)) {
            const n = counts[c] || 0;
            if (n < min || n > max) {
                p(`layout.${section} must hold ${min === max ? min : `${min}-${max}`} ${c} (it has ${n})`);
            }
        }
    }
    if (rules) {
        const [min, max] = rules.buttons;
        if (buttonItems < min || buttonItems > max) {
            p(`template_type ${type} takes ${min === max ? min : `${min}-${max}`} buttons (it has ${buttonItems})`);
        }
        if (rules.imagesNeedButton && hasImages && buttonItems < 1) p("a template with IMAGES needs at least 1 button");
    }

    for (const name of new Set(used)) {
        if (!declared.has(name)) p(`<${name}> is used in the layout but not declared in params`);
    }
    return problems;
}

function range(p, at, value, min, max) {
    if (typeof value !== "string" && typeof value !== "number") {
        p(`${at} is required (${min}-${max} characters)`);
        return;
    }
    const n = len(value);
    if (n < min || n > max) p(`${at} must be ${min}-${max} characters (it is ${n})`);
}

function attachment(p, at, a) {
    if (!a || typeof a !== "object") return p(`${at} must be { "type": "IMAGE", "media_id": "..." }`);
    if (a.type !== "IMAGE") p(`${at}.type must be "IMAGE"`);
    if (!a.media_id) p(`${at}.media_id is required (from \`zbs upload-image\`)`);
}

function checkComponent(name, c, at, p, used) {
    const where = `${at}.${name}`;
    if (!c || typeof c !== "object") return p(`${where} must be an object`);
    switch (name) {
        case "TITLE": {
            range(p, `${where}.value`, c.value, 9, 65);
            const ph = placeholders(c.value);
            if (ph.length > 4) p(`${where} may use at most 4 params (it uses ${ph.length})`);
            used.push(...ph);
            break;
        }
        case "PARAGRAPH": {
            range(p, `${where}.value`, c.value, 9, 400);
            const ph = placeholders(c.value);
            if (ph.length > 10) p(`${where} may use at most 10 params (it uses ${ph.length})`);
            used.push(...ph);
            break;
        }
        case "OTP":
            range(p, `${where}.value`, c.value, 1, 10);
            used.push(...placeholders(c.value));
            break;
        case "TABLE": {
            const rows = c.rows;
            if (!Array.isArray(rows) || rows.length < 2 || rows.length > 8) {
                p(`${where}.rows must hold 2-8 rows`);
                break;
            }
            rows.forEach((r, i) => {
                const ra = `${where}.rows[${i}]`;
                range(p, `${ra}.title`, r?.title, 3, 36);
                if (placeholders(r?.title).length) p(`${ra}.title must be fixed text (no params)`);
                range(p, `${ra}.value`, r?.value, 3, 90);
                used.push(...placeholders(r?.value));
                if (r?.row_type !== undefined && ![0, 1, 2, 3, 4, 5].includes(Number(r.row_type))) {
                    p(`${ra}.row_type must be 0-5`);
                }
            });
            break;
        }
        case "LOGO":
            attachment(p, `${where}.light`, c.light);
            attachment(p, `${where}.dark`, c.dark);
            break;
        case "IMAGES":
            if (!Array.isArray(c.items) || c.items.length < 1 || c.items.length > 3) {
                p(`${where}.items must hold 1-3 images`);
                break;
            }
            c.items.forEach((a, i) => attachment(p, `${where}.items[${i}]`, a));
            break;
        case "BUTTONS":
            if (!Array.isArray(c.items) || c.items.length < 1) {
                p(`${where}.items must hold at least 1 button`);
                break;
            }
            c.items.forEach((b, i) => {
                const ba = `${where}.items[${i}]`;
                const t = Number(b?.type);
                if (!BUTTON_TYPES[t]) p(`${ba}.type must be 1-14`);
                else if (t === 6) p(`${ba}.type 6 is no longer accepted (since 16/03/2026); use 7`);
                range(p, `${ba}.title`, b?.title, 5, 30);
                if (placeholders(b?.title).length) p(`${ba}.title must be fixed text (no params)`);
                if (!b?.content) p(`${ba}.content is required (link or phone number)`);
                used.push(...placeholders(b?.content));
            });
            break;
        case "PAYMENT": {
            if (!BIN_CODES[String(c.bank_code)]) p(`${where}.bank_code must be a BIN code from the list`);
            range(p, `${where}.account_name`, c.account_name, 1, 100);
            // The components page names it bank_account; the create/edit examples send account_number.
            const account = c.bank_account ?? c.account_number;
            range(p, `${where}.bank_account`, account, 1, 100);
            for (const f of ["account_name", "bank_account", "account_number", "bank_code"]) {
                if (placeholders(c[f]).length) p(`${where}.${f} must be fixed text (no params)`);
            }
            if (c.amount === undefined || c.amount === "") p(`${where}.amount is required`);
            else if (placeholders(c.amount).length) used.push(...placeholders(c.amount));
            else {
                const n = Number(String(c.amount).replace(/[,.\s]/g, ""));
                if (!Number.isFinite(n) || n < 2000 || n > 500_000_000) {
                    p(`${where}.amount must be 2,000-500,000,000 when fixed`);
                }
            }
            if (c.note !== undefined) {
                if (placeholders(c.note).length) used.push(...placeholders(c.note));
                else range(p, `${where}.note`, c.note, 1, 90);
            }
            break;
        }
        case "VOUCHER":
            for (const [f, max] of [
                ["name", 30],
                ["condition", 40],
                ["voucher_code", 25],
            ]) {
                if (placeholders(c[f]).length) used.push(...placeholders(c[f]));
                else range(p, `${where}.${f}`, c[f], 1, max);
            }
            if (!c.end_date) p(`${where}.end_date is required`);
            used.push(...placeholders(c.end_date), ...placeholders(c.start_date));
            break;
        case "RATING": {
            if (c.rating_type !== undefined && c.rating_type !== "csat") p(`${where}.rating_type must be "csat"`);
            const maxRate = { three_emotions: 3, five_emotions: 5, five_stars: 5 }[c.option];
            if (!maxRate) p(`${where}.option must be three_emotions, five_emotions or five_stars`);
            if (!Array.isArray(c.items) || c.items.length !== 5) {
                p(`${where}.items must hold 5 items`);
                break;
            }
            c.items.forEach((it, i) => {
                const ia = `${where}.items[${i}]`;
                const r = Number(it?.rate);
                if (!Number.isInteger(r) || r < 1 || (maxRate && r > maxRate))
                    p(`${ia}.rate must be 1-${maxRate ?? 5}`);
                range(p, `${ia}.title`, it?.title, 1, 50);
                if (it?.question !== undefined) range(p, `${ia}.question`, it.question, 1, 100);
                if (it?.answers !== undefined) {
                    if (!Array.isArray(it.answers) || it.answers.length < 1 || it.answers.length > 5) {
                        p(`${ia}.answers must hold 1-5 answers`);
                    } else it.answers.forEach((a, j) => range(p, `${ia}.answers[${j}]`, a, 1, 50));
                }
                range(p, `${ia}.thanks`, it?.thanks, 1, 100);
                range(p, `${ia}.description`, it?.description, 1, 200);
            });
            break;
        }
        default:
            p(`${at}: unknown component ${name}`);
    }
}
