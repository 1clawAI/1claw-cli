/**
 * The proxy picks X-Shroud-Provider from the model id. Pearl's ids keep their
 * slash (`deepseek-ai/DeepSeek-V4-Pro-0813`) and must reach Shroud as Pearl,
 * unchanged. They used to fall through to the openai default.
 *
 * Runs against `dist/`, so `npm run build` first.
 * Run: node --test src/__tests__/proxy-provider-detect.test.mjs
 */
import test from "node:test";
import assert from "node:assert";

import { detectProvider, splitNamespacedModel } from "../../dist/src/commands/proxy.js";

test("Pearl model ids route to pearl and keep their slash", () => {
    for (const id of [
        "deepseek-ai/DeepSeek-V4-Pro-0813",
        "deepseek-ai/DeepSeek-V4.1-Flash",
        "Qwen/Qwen3.8-27B",
        "zai-org/GLM-5.3",
    ]) {
        assert.strictEqual(detectProvider(id), "pearl", id);
        assert.strictEqual(splitNamespacedModel(id), null, `${id} is not stripped`);
    }
});

test("existing prefixes are unchanged", () => {
    assert.strictEqual(detectProvider("gpt-4o-mini"), "openai");
    assert.strictEqual(detectProvider("claude-sonnet-4-6"), "anthropic");
    assert.strictEqual(detectProvider("openrouter/anthropic/claude-3.5-sonnet"), "openrouter");
    assert.strictEqual(detectProvider("something-unknown"), "openai");
});
