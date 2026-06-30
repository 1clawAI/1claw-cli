/** Modules superseded by `1claw spawn <template>`. */
export const SPAWN_REPLACEMENT_MODULES = ["langchain", "elizaos"] as const;

export type SpawnReplacementModule = (typeof SPAWN_REPLACEMENT_MODULES)[number];

/** Return module names that should warn users to use `1claw spawn` instead. */
export function deprecatedSpawnModuleNames(
    moduleNames: string[],
): SpawnReplacementModule[] {
    const deprecated = new Set<string>(SPAWN_REPLACEMENT_MODULES);
    return moduleNames.filter((n): n is SpawnReplacementModule =>
        deprecated.has(n),
    );
}

/** Human-readable deprecation warning for init --module usage. */
export function deprecatedSpawnModuleWarning(
    moduleNames: string[],
): string | null {
    const deprecated = deprecatedSpawnModuleNames(moduleNames);
    if (deprecated.length === 0) return null;
    return `--module ${deprecated.join(", ")} is deprecated. Use \`1claw spawn ${deprecated[0]}\` instead.`;
}
