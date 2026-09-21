// Where the notebook and its compiled table live. One definition, so the CLI
// and the drift test can never disagree about which files they are comparing.
import { fileURLToPath } from "node:url";

export const NOTEBOOK_PATH = fileURLToPath(new URL("../../library/situations.md", import.meta.url));
export const COMPILED_PATH = fileURLToPath(new URL("../core/situations.data.ts", import.meta.url));
