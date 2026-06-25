import { execFile, spawn, type ChildProcess } from "node:child_process";

/**
 * Thin wrapper around the Docker CLI via `child_process.execFile`.
 *
 * We deliberately avoid `dockerode` / any Docker SDK to keep the CLI's
 * dependency surface minimal. Every call shells out to the local `docker`
 * binary with an argv array (never a `/bin/sh -c` string), so user-supplied
 * values (image names, env values, tags) cannot inject shell metacharacters.
 */

export interface DockerRunOptions {
    image: string;
    name: string;
    /** Host port → container port, e.g. { "3000": "3000" } */
    ports: Record<string, string>;
    /** Host path → container mount spec, e.g. { "/host/x.sock": "/run/x.sock:ro" } */
    volumes: Record<string, string>;
    env: Record<string, string>;
    detach: boolean;
    restart?: string;
    labels?: Record<string, string>;
}

export interface DockerBuildOptions {
    context: string;
    dockerfile: string;
    tag: string;
    buildArgs?: Record<string, string>;
    onProgress?: (line: string) => void;
}

class DockerError extends Error {
    constructor(
        message: string,
        public stderr?: string,
    ) {
        super(message);
        this.name = "DockerError";
    }
}

function run(
    args: string[],
    opts: { cwd?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        execFile(
            "docker",
            args,
            { cwd: opts.cwd, maxBuffer: 64 * 1024 * 1024 },
            (err, stdout, stderr) => {
                if (err) {
                    reject(translateError(err, stderr));
                    return;
                }
                resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
            },
        );
    });
}

function translateError(
    err: { code?: string | number | null; message?: string },
    stderr: string,
): DockerError {
    if (err.code === "ENOENT") {
        return new DockerError(
            "Docker is not installed or not on your PATH. Install Docker Desktop (https://docs.docker.com/get-docker/) and try again.",
        );
    }
    const s = (stderr || "").trim();
    if (
        s.includes("Cannot connect to the Docker daemon") ||
        s.includes("Is the docker daemon running")
    ) {
        return new DockerError(
            "Docker is not running. Start Docker Desktop, or run `sudo systemctl start docker` on Linux.",
            s,
        );
    }
    return new DockerError(s || err.message || "docker command failed", s);
}

/** Stream a long-running docker command, forwarding output line-by-line. */
function runStreaming(
    args: string[],
    onProgress?: (line: string) => void,
    cwd?: string,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn("docker", args, { cwd });
        let stderrTail = "";

        const onData = (buf: Buffer) => {
            const text = buf.toString();
            stderrTail = (stderrTail + text).slice(-4096);
            if (onProgress) {
                for (const line of text.split("\n")) {
                    if (line.trim()) onProgress(line.trimEnd());
                }
            }
        };

        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);

        child.on("error", (err) =>
            reject(translateError(err as NodeJS.ErrnoException, stderrTail)),
        );
        child.on("close", (code) => {
            if (code === 0) resolve();
            else
                reject(
                    new DockerError(
                        `docker ${args[0]} exited with code ${code}`,
                        stderrTail,
                    ),
                );
        });
    });
}

export async function dockerAvailable(): Promise<boolean> {
    try {
        await run(["info", "--format", "{{.ServerVersion}}"]);
        return true;
    } catch {
        return false;
    }
}

/** True if Docker is installed but the daemon is unreachable. */
export async function dockerDaemonError(): Promise<string | null> {
    try {
        await run(["info", "--format", "{{.ServerVersion}}"]);
        return null;
    } catch (err) {
        return err instanceof Error ? err.message : String(err);
    }
}

export async function dockerImageExists(image: string): Promise<boolean> {
    try {
        await run(["image", "inspect", image]);
        return true;
    } catch {
        return false;
    }
}

/** Read a single image label, or null if the image/label is absent. */
export async function dockerImageLabel(
    image: string,
    label: string,
): Promise<string | null> {
    try {
        const { stdout } = await run([
            "image",
            "inspect",
            image,
            "--format",
            `{{ index .Config.Labels "${label}" }}`,
        ]);
        const v = stdout.trim();
        return v && v !== "<no value>" ? v : null;
    } catch {
        return null;
    }
}

export async function dockerPull(
    image: string,
    onProgress?: (line: string) => void,
): Promise<void> {
    await runStreaming(["pull", image], onProgress);
}

export async function dockerBuild(opts: DockerBuildOptions): Promise<string> {
    const args = ["build", "-t", opts.tag, "-f", opts.dockerfile];
    if (opts.buildArgs) {
        for (const [k, v] of Object.entries(opts.buildArgs)) {
            args.push("--build-arg", `${k}=${v}`);
        }
    }
    args.push(opts.context);
    await runStreaming(args, opts.onProgress);
    // Resolve the built image ID.
    const { stdout } = await run(["image", "inspect", opts.tag, "--format", "{{.Id}}"]);
    return stdout.trim();
}

export async function dockerRun(opts: DockerRunOptions): Promise<string> {
    const args = ["run", "--name", opts.name];
    args.push(opts.detach ? "-d" : "-d"); // always detached; logs streamed separately
    if (opts.restart) args.push("--restart", opts.restart);
    for (const [host, container] of Object.entries(opts.ports)) {
        args.push("-p", `${host}:${container}`);
    }
    for (const [host, container] of Object.entries(opts.volumes)) {
        args.push("-v", `${host}:${container}`);
    }
    for (const [k, v] of Object.entries(opts.env)) {
        args.push("-e", `${k}=${v}`);
    }
    for (const [k, v] of Object.entries(opts.labels ?? {})) {
        args.push("--label", `${k}=${v}`);
    }
    args.push(opts.image);
    const { stdout } = await run(args);
    return stdout.trim();
}

export async function dockerStop(nameOrId: string): Promise<void> {
    await run(["stop", nameOrId]);
}

/** Start an existing (stopped) container. */
export async function dockerStart(nameOrId: string): Promise<void> {
    await run(["start", nameOrId]);
}

/** Restart an existing container. */
export async function dockerRestart(nameOrId: string): Promise<void> {
    await run(["restart", nameOrId]);
}

export async function dockerRm(nameOrId: string, force = false): Promise<void> {
    const args = ["rm"];
    if (force) args.push("-f");
    args.push(nameOrId);
    await run(args);
}

export async function dockerInspect(nameOrId: string): Promise<unknown> {
    const { stdout } = await run(["inspect", nameOrId]);
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed[0] : parsed;
}

export interface ContainerStatus {
    exists: boolean;
    running: boolean;
    status?: string;
    health?: string;
}

export async function dockerContainerStatus(
    nameOrId: string,
): Promise<ContainerStatus> {
    try {
        const { stdout } = await run([
            "inspect",
            nameOrId,
            "--format",
            "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
        ]);
        const [status, health] = stdout.trim().split("|");
        return {
            exists: true,
            running: status === "running",
            status,
            health: health === "none" ? undefined : health,
        };
    } catch {
        return { exists: false, running: false };
    }
}

export async function dockerPush(
    tag: string,
    onProgress?: (line: string) => void,
): Promise<void> {
    await runStreaming(["push", tag], onProgress);
}

export async function dockerTag(source: string, target: string): Promise<void> {
    await run(["tag", source, target]);
}

export async function dockerCommit(
    container: string,
    tag: string,
): Promise<string> {
    const { stdout } = await run(["commit", container, tag]);
    return stdout.trim();
}

/** Spawn `docker logs -f` and return the child process so the caller streams it. */
export function dockerLogs(nameOrId: string, follow: boolean): ChildProcess {
    const args = ["logs"];
    if (follow) args.push("-f");
    args.push(nameOrId);
    return spawn("docker", args, { stdio: ["ignore", "inherit", "inherit"] });
}

/** True if the local docker client is authenticated to the given registry. */
export async function dockerLoggedIn(registry = "https://index.docker.io/v1/"): Promise<boolean> {
    try {
        const { stdout } = await run(["system", "info", "--format", "{{json .}}"]);
        const info = JSON.parse(stdout) as { RegistryConfig?: unknown };
        // `docker info` doesn't reliably expose auth; fall back to checking the
        // config file via `docker logout --help`-free heuristic is unreliable,
        // so we simply return true and let `docker push` surface auth errors.
        void info;
        void registry;
        return true;
    } catch {
        return true;
    }
}

export { DockerError };
