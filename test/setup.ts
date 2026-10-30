import { afterAll } from "vitest"
import { removeTmpDirs } from "./helpers.js"

// Every test file: once its tests (and their own afterAll hooks, which stop servers first) are done, remove the temp
// folders its tmpDir() calls made. Without this each full run left thousands of box-yard-test-*, -repo-*, -origin-*,
// thin-*, archive-* and boxes-* folders in $TMPDIR.
afterAll(() => removeTmpDirs())
