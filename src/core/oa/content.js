/**
 * OA content (Zalo's OA docs "Nội dung"): articles and video posts through the Article API on `v2.0/article/*`.
 *
 * - create / update answer with a process token, not an id: `v2.0/article/verify` resolves it to the article id
 *   ("Kiểm tra kết quả tiến trình tạo nội dung"); while Zalo is still processing, the call fails with -214
 *   ("Bài viết đang được xử lý"), which {@link waitForArticle} polls through, bounded by a timeout.
 * - Videos for posts are uploaded first (`upload_video/preparevideo`, mp4/avi ≤ 50 MB) and answer with a token
 *   whose `upload_video/verify` status says when the `video_id` is usable.
 * - The documented field limits (title ≤ 150, author ≤ 50, description ≤ 300 characters, the `show`/`hide` values,
 *   the cover and body element shapes) are checked before anything is sent: {@link validateArticle}.
 *
 * Nothing here prints: callers report through src/utils/output.js.
 */

import { OPENAPI_V2, OAError, oaRequest, uploadForm } from "./transport.js";

const MB = 1024 * 1024;

/** The Article API's documented limits (OA docs "Nội dung dạng Bài viết", "Tải video lên cho nội dung bài viết"). */
export const ARTICLE_LIMITS = Object.freeze({
    title: 150,
    author: 50,
    description: 300,
    /** Images used by an article (cover, body) may not exceed 1 MB; they are URLs, so this is not checkable here. */
    imageBytes: 1 * MB,
    videoBytes: 50 * MB,
    videoTypes: Object.freeze(["mp4", "avi"]),
});

/** `upload_video/verify` → `data.status` (OA docs "Các trạng thái của video"). */
export const ARTICLE_VIDEO_STATUS = Object.freeze({
    0: "unknown",
    1: "ready",
    2: "locked",
    3: "processing",
    4: "failed",
    5: "deleted",
});

/** Zalo's "article is still being processed" code: verify is called again later. */
const ARTICLE_PROCESSING = -214;
const SHOW_HIDE = ["show", "hide"];
const COVER_VIEWS = ["horizontal", "vertical", "square"];

function invalid(message) {
    return new OAError(message, { code: "invalid_article" });
}

/** Characters as the docs count them ("Tối đa 150 ký tự"): code points, so an emoji is one. */
function charCount(s) {
    return [...String(s)].length;
}

function isObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
}

function requireString(obj, key, where, problems) {
    if (typeof obj[key] !== "string" || obj[key].trim() === "") problems.push(`${where}${key} is required (a string)`);
}

function checkMax(obj, key, max, problems) {
    if (typeof obj[key] === "string" && charCount(obj[key]) > max) {
        problems.push(`${key} is ${charCount(obj[key])} characters; Zalo allows at most ${max}`);
    }
}

function checkShowHide(obj, key, where, problems) {
    if (obj[key] !== undefined && !SHOW_HIDE.includes(obj[key])) {
        problems.push(`${where}${key} must be "show" or "hide"`);
    }
}

function checkCover(cover, problems) {
    if (!isObject(cover)) {
        problems.push("cover is required (an object with cover_type photo or video)");
        return;
    }
    if (cover.cover_type === "photo") {
        requireString(cover, "photo_url", "cover.", problems);
    } else if (cover.cover_type === "video") {
        requireString(cover, "video_id", "cover.", problems);
        if (!COVER_VIEWS.includes(cover.cover_view)) {
            problems.push(`cover.cover_view must be one of ${COVER_VIEWS.join(", ")}`);
        }
    } else {
        problems.push('cover.cover_type must be "photo" or "video"');
    }
    if (!SHOW_HIDE.includes(cover.status)) problems.push('cover.status must be "show" or "hide"');
}

function checkBody(body, problems) {
    if (!Array.isArray(body) || body.length === 0) {
        problems.push("body is required (a non-empty array of paragraphs)");
        return;
    }
    body.forEach((p, i) => {
        const where = `body[${i}].`;
        if (!isObject(p)) {
            problems.push(`body[${i}] must be an object`);
            return;
        }
        switch (p.type) {
            case "text":
                requireString(p, "content", where, problems);
                break;
            case "image":
                requireString(p, "url", where, problems);
                break;
            case "video":
                if (!p.url && !p.video_id) problems.push(`${where}url or ${where}video_id is required`);
                break;
            case "product":
                requireString(p, "id", where, problems);
                break;
            default:
                problems.push(`${where}type must be text, image, video or product`);
        }
    });
}

/**
 * Check an article or video post against the documented body before it is sent; throws OAError `invalid_article`
 * listing every problem.
 *
 * - `type: "normal"` (OA docs "Nội dung dạng Bài viết"): `title` ≤ 150, `author` ≤ 50, `cover`, `description` ≤ 300,
 *   `body[]` (text / image / video / product paragraphs); optional `related_medias` (array of ids),
 *   `tracking_link`, `status`, `comment`.
 * - `type: "video"` (OA docs "Nội dung dạng Video"): `title` ≤ 150, `description` ≤ 300, `video_id`, `avatar`;
 *   optional `status`, `comment`.
 * - `status` and `comment` take `show` or `hide`; an update (`{ update: true }`) also needs `id`.
 *
 * @param {object} article - the request body
 * @param {{ update?: boolean }} [opts]
 * @returns {object} the same article
 */
export function validateArticle(article, { update = false } = {}) {
    if (!isObject(article)) throw invalid("The article must be a JSON object");
    const problems = [];
    if (update) requireString(article, "id", "", problems);
    if (article.type === "normal") {
        requireString(article, "title", "", problems);
        requireString(article, "author", "", problems);
        requireString(article, "description", "", problems);
        checkCover(article.cover, problems);
        checkBody(article.body, problems);
        if (article.related_medias !== undefined && !Array.isArray(article.related_medias)) {
            problems.push("related_medias must be an array of article ids");
        }
        if (article.tracking_link !== undefined && typeof article.tracking_link !== "string") {
            problems.push("tracking_link must be a string");
        }
        checkMax(article, "author", ARTICLE_LIMITS.author, problems);
    } else if (article.type === "video") {
        requireString(article, "title", "", problems);
        requireString(article, "description", "", problems);
        requireString(article, "video_id", "", problems);
        requireString(article, "avatar", "", problems);
    } else {
        problems.push('type must be "normal" (an article) or "video" (a video post)');
    }
    checkMax(article, "title", ARTICLE_LIMITS.title, problems);
    checkMax(article, "description", ARTICLE_LIMITS.description, problems);
    checkShowHide(article, "status", "", problems);
    checkShowHide(article, "comment", "", problems);
    if (problems.length) throw invalid(`The article is not valid: ${problems.join("; ")}`);
    return article;
}

/**
 * Create an article or video post (POST `v2.0/article/create`, JSON body, OA docs "Nội dung dạng Bài viết" /
 * "Nội dung dạng Video"). The body is checked by {@link validateArticle} first. Zalo answers `data.token`, which
 * {@link verifyArticle} / {@link waitForArticle} resolve to the article id.
 *
 * @param {object} article
 * @param {string} [oaId]
 * @returns {Promise<{ error: number, message: string, data: { token: string } }>}
 */
export async function createArticle(article, oaId = "default") {
    validateArticle(article);
    return oaRequest({ method: "POST", url: `${OPENAPI_V2}/article/create`, body: article, oaId });
}

/**
 * Update an article or video post (POST `v2.0/article/update`, the create body plus `id`; OA docs "Cập nhật nội
 * dung" / "Chỉnh sửa nội dung dạng video"). Answers `data.token`, resolved like create's.
 *
 * @param {object} article - must carry `id`
 * @param {string} [oaId]
 * @returns {Promise<{ error: number, message: string, data: { token: string } }>}
 */
export async function updateArticle(article, oaId = "default") {
    validateArticle(article, { update: true });
    return oaRequest({ method: "POST", url: `${OPENAPI_V2}/article/update`, body: article, oaId });
}

/**
 * Resolve a create/update token (POST `v2.0/article/verify`, body `{ token }`; OA docs "Kiểm tra kết quả tiến trình
 * tạo nội dung"). Answers `data.id`; fails with -214 while Zalo is still processing the article.
 *
 * @param {string} token
 * @param {string} [oaId]
 * @returns {Promise<{ error: number, message: string, data: { id: string } }>}
 */
export async function verifyArticle(token, oaId = "default") {
    if (!token) throw invalid("A token from article create or update is required");
    return oaRequest({ method: "POST", url: `${OPENAPI_V2}/article/verify`, body: { token }, oaId });
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll `v2.0/article/verify` until the token resolves to an article id. "Still processing" (-214, or a success
 * without `data.id`) waits `intervalMs` and asks again; any other error is thrown at once. Gives up after
 * `timeoutMs` with OAError `article_pending` whose `data.token` can be verified later.
 *
 * @param {string} token
 * @param {object} [opts]
 * @param {string} [opts.oaId]
 * @param {number} [opts.timeoutMs] - default 60 000
 * @param {number} [opts.intervalMs] - default 2 000
 * @param {(ms: number) => Promise<void>} [opts.sleep] - test seam
 * @param {() => number} [opts.now] - test seam
 * @returns {Promise<{ id: string, attempts: number, result: object }>}
 */
export async function waitForArticle(
    token,
    { oaId = "default", timeoutMs = 60_000, intervalMs = 2_000, sleep = sleepMs, now = Date.now } = {},
) {
    const deadline = now() + timeoutMs;
    let attempts = 0;
    for (;;) {
        attempts++;
        try {
            const result = await verifyArticle(token, oaId);
            if (result?.data?.id) return { id: result.data.id, attempts, result };
        } catch (e) {
            if (!(e instanceof OAError) || e.code !== ARTICLE_PROCESSING) throw e;
        }
        if (now() + intervalMs > deadline) {
            throw new OAError(
                `Zalo is still processing the article after ${Math.round(timeoutMs / 1000)} s ` +
                    `(${attempts} checks). Check it later with: zalo-agent oa article verify ${token}`,
                { code: "article_pending", data: { token } },
            );
        }
        await sleep(intervalMs);
    }
}

/**
 * Delete an article or video post (POST `v2.0/article/remove`, body `{ id }`; OA docs "Xóa nội dung dạng bài viết").
 *
 * @param {string} articleId
 * @param {string} [oaId]
 * @returns {Promise<{ error: number, message: string }>}
 */
export async function removeArticle(articleId, oaId = "default") {
    if (!articleId) throw invalid("An article id is required");
    return oaRequest({ method: "POST", url: `${OPENAPI_V2}/article/remove`, body: { id: articleId }, oaId });
}

function checkPaging(offset, limit) {
    if (!Number.isInteger(offset) || offset < 0) throw invalid("offset must be a whole number ≥ 0");
    if (!Number.isInteger(limit) || limit < 1) throw invalid("limit must be a whole number ≥ 1");
}

function checkType(type) {
    if (type !== "normal" && type !== "video") throw invalid('type must be "normal" or "video"');
}

/**
 * One page of articles or video posts (GET `v2.0/article/getslice?offset&limit&type`; OA docs "Lấy danh sách nội
 * dung dạng bài viết" / "… dạng video"). Answers `data.medias[]` and `data.total`.
 *
 * @param {object} [opts]
 * @param {number} [opts.offset] - default 0
 * @param {number} [opts.limit] - default 10
 * @param {"normal"|"video"} [opts.type] - default "normal"
 * @param {string} [opts.oaId]
 * @returns {Promise<{ error: number, message: string, data: { medias: object[], total: number } }>}
 */
export async function getArticleList({ offset = 0, limit = 10, type = "normal", oaId = "default" } = {}) {
    checkPaging(offset, limit);
    checkType(type);
    return oaRequest({ url: `${OPENAPI_V2}/article/getslice`, query: { offset, limit, type }, oaId });
}

/**
 * Every article (or video post) of the OA: walks `getslice` from offset 0, `pageSize` at a time, until `total` is
 * reached or a page comes back empty.
 *
 * @param {object} [opts]
 * @param {"normal"|"video"} [opts.type]
 * @param {number} [opts.pageSize] - default 10
 * @param {string} [opts.oaId]
 * @returns {Promise<{ medias: object[], total: number, pages: number }>}
 */
export async function getAllArticles({ type = "normal", pageSize = 10, oaId = "default" } = {}) {
    const medias = [];
    let total = 0;
    let pages = 0;
    for (let offset = 0; ; offset += pageSize) {
        const page = await getArticleList({ offset, limit: pageSize, type, oaId });
        pages++;
        const got = page?.data?.medias || [];
        total = Number(page?.data?.total) || 0;
        medias.push(...got);
        if (got.length === 0 || medias.length >= total) break;
    }
    return { medias, total, pages };
}

/**
 * One article or video post (GET `v2.0/article/getdetail?id`; OA docs "Lấy chi tiết của nội dung dạng bài viết" /
 * "… dạng video").
 *
 * @param {string} articleId
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function getArticleDetail(articleId, oaId = "default") {
    if (!articleId) throw invalid("An article id is required");
    return oaRequest({ url: `${OPENAPI_V2}/article/getdetail`, query: { id: articleId }, oaId });
}

/**
 * Upload a video for a post (POST multipart `v2.0/article/upload_video/preparevideo`, part `file`; OA docs "Tải
 * video lên cho nội dung bài viết"): mp4 or avi, at most 50 MB, checked before sending. Answers `data.token` for
 * {@link getArticleVideoStatus}.
 *
 * @param {string} filePath
 * @param {string} [oaId]
 * @returns {Promise<{ error: number, message: string, data: { token: string } }>}
 */
export async function uploadArticleVideo(filePath, oaId = "default") {
    return uploadForm(`${OPENAPI_V2}/article/upload_video/preparevideo`, filePath, {
        field: "file",
        maxBytes: ARTICLE_LIMITS.videoBytes,
        types: [...ARTICLE_LIMITS.videoTypes],
        oaId,
    });
}

/**
 * The processing status of an uploaded video (GET `v2.0/article/upload_video/verify`, `token` from the upload; OA
 * docs "Kiểm tra trạng thái của video"): `data.status` (see {@link ARTICLE_VIDEO_STATUS}), `video_id`,
 * `convert_percent`, …
 *
 * The docs list `token` under "Tham số header" next to `access_token`, so it is sent as a `token` header, not a
 * query parameter.
 *
 * @param {string} token
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function getArticleVideoStatus(token, oaId = "default") {
    if (!token) throw invalid("A token from article video-upload is required");
    return oaRequest({ url: `${OPENAPI_V2}/article/upload_video/verify`, headers: { token }, oaId });
}

/**
 * Poll {@link getArticleVideoStatus} while the video is processing (status 3, or 0 "unknown" just after upload).
 * Returns the last answer once the status is final (1 ready, 2 locked, 4 failed, 5 deleted); gives up after
 * `timeoutMs` with OAError `video_pending`.
 *
 * @param {string} token
 * @param {object} [opts] - as for {@link waitForArticle}; default timeout 300 000 ms, interval 5 000 ms
 * @returns {Promise<object>}
 */
export async function waitForArticleVideo(
    token,
    { oaId = "default", timeoutMs = 300_000, intervalMs = 5_000, sleep = sleepMs, now = Date.now } = {},
) {
    const deadline = now() + timeoutMs;
    for (;;) {
        const result = await getArticleVideoStatus(token, oaId);
        const status = Number(result?.data?.status);
        if (status !== 0 && status !== 3) return result;
        if (now() + intervalMs > deadline) {
            throw new OAError(
                `The video is still processing after ${Math.round(timeoutMs / 1000)} s ` +
                    `(${result?.data?.convert_percent ?? 0}%). Check it later with: ` +
                    `zalo-agent oa article video-status ${token}`,
                { code: "video_pending", data: { token, last: result?.data } },
            );
        }
        await sleep(intervalMs);
    }
}
