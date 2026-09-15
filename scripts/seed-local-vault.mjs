// Creates a scratch local vault + policy for the daemon-proxy test.
// ONECLAW_CONFIG_DIR must point at a throwaway directory.
import { createVault, addSecret, saveVault } from "../dist/src/local-vault.js";
import { loadPolicy, savePolicy, setSecretPolicy } from "../dist/src/local-policy.js";
const pass = process.env.ONECLAW_VAULT_PASSPHRASE;
const v = createVault(pass);
addSecret(v, "bankr-api-key", "bk_usr_FROM_THE_VAULT");
saveVault(v, pass);
const p = loadPolicy();
setSecretPolicy(p, "bankr-api-key", { allowed_hosts: ["127.0.0.1"], inject_as: "header", header_name: "X-API-Key" });
savePolicy(p);
console.log("seeded");
