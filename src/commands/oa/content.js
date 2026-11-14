/**
 * `oa article`: OA articles and video posts (Zalo's OA docs "Nội dung", the Article API on `v2.0/article/*`).
 */

import {
    ARTICLE_LIMITS,
    ARTICLE_VIDEO_STATUS,
    createArticle,
    getAllArticles,
    getArticleDetail,
    getArticleList,
    getArticleVideoStatus,
    removeArticle,
    updateArticle,
    uploadArticleVideo,
    verifyArticle,
    waitForArticle,
    waitForArticleVideo,
} from "../../core/oa/content.js";
import { guardSubcommand } from "../../core/confirm-guard.js";
import { readJsonInput } from "../../utils/json-input.js";
import { success, error, info, output, warning } from "../../utils/output.js";

const BODY_HELP =
    `JSON body as Zalo's OA docs give it, inline or @file. An article: {"type":"normal","title":"…",` +
    `"author":"…","cover":{"cover_type":"photo","photo_url":"…","status":"show"},"description":"…",` +
    `"body":[{"type":"text","content":"…"}],"status":"show","comment":"show"}. A video post: ` +
    `{"type":"video","title":"…","description":"…","video_id":"…","avatar":"<image url>"}. Limits: title ≤ ` +
    `${ARTICLE_LIMITS.title}, author ≤ ${ARTICLE_LIMITS.author}, description ≤ ${ARTICLE_LIMITS.description} ` +
    `characters; images ≤ 1 MB.`;

/** A positive number of seconds, as milliseconds. */
function seconds(value, name) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number of seconds`);
    return Math.round(n * 1000);
}

/** A whole number ≥ min. */
function whole(value, name, min) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be a whole number ≥ ${min}`);
    return n;
}

function videoStatusText(d) {
    const word = ARTICLE_VIDEO_STATUS[d?.status] ?? `status ${d?.status}`;
    return `${word}${d?.status === 3 ? ` (${d.convert_percent ?? 0}%)` : ""}`;
}

/**
 * Register `oa article` on the `oa` command.
 * @param {import("commander").Command} oa
 */
export function registerContentCommands(oa) {
    const json = () => oa.parent?.opts().json;

    const article = oa.command("article").description("Manage OA articles and video posts");

    /** create and update: send, then resolve the answer's token to the article id unless --no-wait. */
    async function submit(send, body, opts, verb) {
        const timeoutMs = seconds(opts.timeout, "--timeout");
        const intervalMs = seconds(opts.interval, "--interval");
        const sent = await send(body, opts.oaId);
        const token = sent?.data?.token;
        if (!opts.wait || !token) {
            output(sent, json(), () => {
                success(`Article ${verb}; Zalo is processing it`);
                if (token) info(`Token: ${token}`);
                info("Get its id with: zalo-agent oa article verify <token>");
            });
            return;
        }
        if (!json()) info(`Article ${verb}; waiting for Zalo to process it...`);
        const done = await waitForArticle(token, { oaId: opts.oaId, timeoutMs, intervalMs });
        output({ id: done.id, token }, json(), () => success(`Article ${verb}: id ${done.id}`));
    }

    article
        .command("create <article-json>")
        .description("Create an article or video post (JSON, inline or @file), then wait for its id")
        .addHelpText("after", `\n<article-json>: ${BODY_HELP}`)
        .option("--no-wait", "Return Zalo's token at once instead of waiting for the article id")
        .option("--timeout <seconds>", "How long to wait for the article id", "60")
        .option("--interval <seconds>", "Seconds between checks while waiting", "2")
        .option("--oa-id <id>", "OA identifier", "default")
        .action(async (articleJson, opts) => {
            try {
                await submit(createArticle, readJsonInput(articleJson, "the article"), opts, "submitted");
            } catch (e) {
                error(e.message);
            }
        });

    article
        .command("verify <token>")
        .description("Resolve a token from article create/update to the article id (fails while Zalo is processing)")
        .option("--oa-id <id>", "OA identifier", "default")
        .action(async (token, opts) => {
            try {
                const result = await verifyArticle(token, opts.oaId);
                output(result, json(), () => success(`Article id: ${result.data?.id ?? "N/A"}`));
            } catch (e) {
                error(e.code === -214 ? `${e.message}. Try again in a moment` : e.message);
            }
        });

    article
        .command("update <article-id> <article-json>")
        .description("Update an article or video post (the whole body, as for create), then wait for its id")
        .addHelpText("after", `\n<article-json>: ${BODY_HELP}`)
        .option("--no-wait", "Return Zalo's token at once instead of waiting")
        .option("--timeout <seconds>", "How long to wait", "60")
        .option("--interval <seconds>", "Seconds between checks while waiting", "2")
        .option("--oa-id <id>", "OA identifier", "default")
        .action(async (articleId, articleJson, opts) => {
            try {
                const body = readJsonInput(articleJson, "the article");
                if (body === null || typeof body !== "object" || Array.isArray(body)) {
                    throw new Error("The article must be a JSON object");
                }
                if (body.id !== undefined && body.id !== articleId) {
                    throw new Error(`The JSON's id (${body.id}) is not the article id given (${articleId})`);
                }
                await submit(updateArticle, { id: articleId, ...body }, opts, "updated");
            } catch (e) {
                error(e.message);
            }
        });

    article
        .command("remove <article-id>")
        .description("Delete an article or video post")
        .option("--oa-id <id>", "OA identifier", "default")
        .action(async (articleId, opts) => {
            try {
                const result = await removeArticle(articleId, opts.oaId);
                output(result, json(), () => success(`Article ${articleId} deleted`));
            } catch (e) {
                error(e.message);
            }
        });

    article
        .command("list")
        .description("List articles (--type normal) or video posts (--type video)")
        .option("--type <type>", "normal or video", "normal")
        .option("--offset <n>", "Start position", "0")
        .option("--limit <n>", "How many (per page with --all)", "10")
        .option("--all", "Every page, from offset 0")
        .option("--oa-id <id>", "OA identifier", "default")
        .action(async (opts) => {
            try {
                const limit = whole(opts.limit, "--limit", 1);
                let result;
                if (opts.all) {
                    const all = await getAllArticles({ type: opts.type, pageSize: limit, oaId: opts.oaId });
                    result = { medias: all.medias, total: all.total };
                } else {
                    const offset = whole(opts.offset, "--offset", 0);
                    result = await getArticleList({ offset, limit, type: opts.type, oaId: opts.oaId });
                }
                output(result, json(), () => {
                    const d = result.data ?? result;
                    const medias = d.medias || [];
                    info(
                        `${opts.type === "video" ? "Video posts" : "Articles"}: ${medias.length} of ${d.total ?? "?"}`,
                    );
                    for (const a of medias) {
                        console.log(
                            `  - ${a.id}: ${a.title || "N/A"} [${a.status ?? ""}] views ${a.total_view ?? 0}, ` +
                                `shares ${a.total_share ?? 0}`,
                        );
                    }
                });
            } catch (e) {
                error(e.message);
            }
        });

    article
        .command("detail <article-id>")
        .description("Show one article or video post")
        .option("--oa-id <id>", "OA identifier", "default")
        .action(async (articleId, opts) => {
            try {
                const result = await getArticleDetail(articleId, opts.oaId);
                output(result, json(), () => {
                    const d = result.data || {};
                    info(`Title: ${d.title || "N/A"}`);
                    if (d.type) info(`Type: ${d.type}`);
                    if (d.status !== undefined) info(`Status: ${d.status}`);
                    if (d.author) info(`Author: ${d.author}`);
                    if (d.description) info(`Description: ${d.description}`);
                    if (d.video_id) info(`Video id: ${d.video_id}`);
                    if (d.comment) info(`Comments: ${d.comment}`);
                });
            } catch (e) {
                error(e.message);
            }
        });

    article
        .command("video-upload <file>")
        .description(
            `Upload a video for a post or a video cover (${ARTICLE_LIMITS.videoTypes.join("/")}, ≤ 50 MB); ` +
                "prints the token for video-status",
        )
        .option("--wait", "Wait until Zalo has processed the video, and print its video_id")
        .option("--timeout <seconds>", "How long to wait with --wait", "300")
        .option("--interval <seconds>", "Seconds between checks with --wait", "5")
        .option("--oa-id <id>", "OA identifier", "default")
        .action(async (file, opts) => {
            try {
                const timeoutMs = seconds(opts.timeout, "--timeout");
                const intervalMs = seconds(opts.interval, "--interval");
                const sent = await uploadArticleVideo(file, opts.oaId);
                const token = sent?.data?.token;
                if (!opts.wait || !token) {
                    output(sent, json(), () => {
                        success("Video uploaded; Zalo is processing it");
                        if (token) info(`Token: ${token}`);
                        info("Check it with: zalo-agent oa article video-status <token>");
                    });
                    return;
                }
                if (!json()) info("Video uploaded; waiting for Zalo to process it...");
                const done = await waitForArticleVideo(token, { oaId: opts.oaId, timeoutMs, intervalMs });
                if (done.data?.status !== 1) {
                    error(
                        `Zalo did not accept the video: ${videoStatusText(done.data)}. ${done.data?.status_message ?? ""}`,
                    );
                    return;
                }
                output({ token, ...done.data }, json(), () => reportVideo(done.data));
            } catch (e) {
                error(e.message);
            }
        });

    article
        .command("video-status <token>")
        .description("Processing status of an uploaded video: 1 ready, 3 processing, 4 failed, …")
        .option("--oa-id <id>", "OA identifier", "default")
        .action(async (token, opts) => {
            try {
                const result = await getArticleVideoStatus(token, opts.oaId);
                output(result, json(), () => reportVideo(result.data));
            } catch (e) {
                error(e.message);
            }
        });

    function reportVideo(d = {}) {
        const line = `Video ${d.video_name ?? ""}: ${videoStatusText(d)}`.replace(" :", ":");
        if (d.status === 1) success(line);
        else if (d.status === 2 || d.status === 4 || d.status === 5) warning(line);
        else info(line);
        if (d.video_id) info(`video_id: ${d.video_id}`);
        if (d.status_message) info(d.status_message);
    }

    guardSubcommand(article, "remove", "oa.article.remove", {
        target: (articleId, opts) => ({ articleId, oaId: opts.oaId }),
    });
}
