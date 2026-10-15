// Mirrors the proven mempalace-hud build: tsc-less minimal bundle via Bun with
// @opentui/solid's reactive JSX transform. Sources are .tsx in tui/src; the
// pure logic module (format.js) ships as-is and is also imported directly by
// the root unit tests.
import { rm, cp, mkdir } from "node:fs/promises"

const root = new URL("..", import.meta.url).pathname
const dist = `${root}dist`

await rm(dist, { recursive: true, force: true })

const result = await Bun.build({
  entrypoints: [`${root}src/index.tsx`],
  outdir: dist,
  target: "bun",
  packages: "external",
  plugins: [
    (await import("@opentui/solid/bun-plugin")).createSolidTransformPlugin(),
  ],
})
if (!result.success) {
  console.error(result.logs)
  process.exit(1)
}

// Ship the pure logic module verbatim next to the bundle.
await mkdir(dist, { recursive: true })
await cp(`${root}src/format.js`, `${dist}/format.js`)
