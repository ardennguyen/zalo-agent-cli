import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isDownloadableMedia } from "./media-downloader.js";

describe("isDownloadableMedia", () => {
    it("returns true for image type", () => {
        assert.ok(isDownloadableMedia("image"));
    });

    it("returns true for audio type", () => {
        assert.ok(isDownloadableMedia("audio"));
    });

    it("returns true for voice type", () => {
        assert.ok(isDownloadableMedia("voice"));
    });

    it("returns true for video type", () => {
        assert.ok(isDownloadableMedia("video"));
    });

    it("returns true for gif type", () => {
        assert.ok(isDownloadableMedia("gif"));
    });

    it("returns true for file type", () => {
        assert.ok(isDownloadableMedia("file"));
    });

    it("returns false for text type", () => {
        assert.equal(isDownloadableMedia("text"), false);
    });

    it("returns false for link type", () => {
        assert.equal(isDownloadableMedia("link"), false);
    });

    it("returns false for sticker type", () => {
        assert.equal(isDownloadableMedia("sticker"), false);
    });

    it("returns false for undefined type", () => {
        assert.equal(isDownloadableMedia(undefined), false);
    });
});
