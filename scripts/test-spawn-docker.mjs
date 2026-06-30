#!/usr/bin/env node
// Optional Docker integration test for `1claw spawn` templates.
// Builds langchain, runs a container, checks /health, then removes everything.
//
// Enabled with ONECLAW_TEST_DOCKER=1 (skipped by default — slow).
// Run after `npm run build`:
//   ONECLAW_TEST_DOCKER=1 node --test scripts/test-spawn-docker.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import {
    SPAWN_SMOKE_CONTAINER,
    SPAWN_SMOKE_IMAGE,
    trackDockerContainer,
    trackDockerImage,
    cleanupTestSuite,
    dockerAvailable,
    waitForHttpOk,
} from "./test-helpers.mjs";

const TMP_CONFIG = mkdtempSync(join(tmpdir(), "1claw-spawn-docker-"));
process.env.ONECLAW_CONFIG_DIR = TMP_CONFIG;

const dockerEnabled = process.env.ONECLAW_TEST_DOCKER === "1";
const HOST_PORT = process.env.ONECLAW_TEST_DOCKER_PORT || "13000";

trackDockerContainer(SPAWN_SMOKE_CONTAINER);
trackDockerImage(SPAWN_SMOKE_IMAGE);

test(
    "langchain spawn smoke: build, run, /health, cleanup",
    { skip: !dockerEnabled && "set ONECLAW_TEST_DOCKER=1 to run Docker spawn tests" },
    async () => {
        assert.ok(
            await dockerAvailable(),
            "ONECLAW_TEST_DOCKER=1 but Docker is not available",
        );

        const docker = await import("../dist/src/lib/docker-client.js");
        const templateRegistry = await import("../dist/src/templates/registry.js");
        const config = await import("../dist/src/lib/container-config.js");

        const dir = templateRegistry.getTemplateDir("langchain");
        const dockerfile = join(dir, "Dockerfile");

        try {
            await docker.dockerBuild({
                context: dir,
                dockerfile,
                tag: SPAWN_SMOKE_IMAGE,
            });

            await docker.dockerRun({
                image: SPAWN_SMOKE_IMAGE,
                name: SPAWN_SMOKE_CONTAINER,
                ports: { [HOST_PORT]: "3000" },
                volumes: {},
                env: {
                    CHAT_UI_PORT: "3000",
                    ONECLAW_LLM_VIA_SHROUD: "false",
                },
                detach: true,
                labels: {
                    "1claw.managed": "test",
                    "1claw.test": "spawn-smoke",
                },
            });

            const res = await waitForHttpOk(
                `http://127.0.0.1:${HOST_PORT}/health`,
                { timeoutMs: 120_000 },
            );
            const body = await res.json();
            assert.equal(body.status, "ok");
            assert.equal(body.framework, "langchain");

            const status = await docker.dockerContainerStatus(SPAWN_SMOKE_CONTAINER);
            assert.ok(status.exists);
            assert.equal(status.running, true);
        } finally {
            await cleanupTestSuite(config, TMP_CONFIG);
        }
    },
);

test.after(async () => {
    const config = await import("../dist/src/lib/container-config.js");
    await cleanupTestSuite(config, TMP_CONFIG);
});
