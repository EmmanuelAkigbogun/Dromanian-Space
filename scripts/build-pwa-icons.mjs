// Renders the installable-app (PWA) icons from desktop/assets/icon.svg:
//   icon-192/512   rounded artwork with transparent corners ("any")
//   maskable-512   full-bleed square, artwork inside the 80% safe zone (Android)
//   apple-touch    full-bleed square; iOS rounds the corners itself
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDirectory = path.join(projectDirectory, 'public', 'icons');
const svg = await readFile(path.join(projectDirectory, 'desktop', 'assets', 'icon.svg'), 'utf8');

const square = svg.replace('rx="112"', 'rx="0"');
// Keep the background full-bleed and shrink only the mark into the safe zone.
const maskable = square.replace(/(<rect[^>]*\/>)([\s\S]*)(<\/svg>)/, '$1<g transform="translate(51.2 51.2) scale(0.8)">$2</g>$3');

const render = (source, size) =>
  new Resvg(source, { fitTo: { mode: 'width', value: size }, background: 'rgba(0, 0, 0, 0)' }).render().asPng();

await mkdir(outDirectory, { recursive: true });
await writeFile(path.join(outDirectory, 'icon-192.png'), render(svg, 192));
await writeFile(path.join(outDirectory, 'icon-512.png'), render(svg, 512));
await writeFile(path.join(outDirectory, 'maskable-512.png'), render(maskable, 512));
await writeFile(path.join(outDirectory, 'apple-touch-icon.png'), render(square, 180));
console.log(`PWA icons written to ${path.relative(projectDirectory, outDirectory)}`);
