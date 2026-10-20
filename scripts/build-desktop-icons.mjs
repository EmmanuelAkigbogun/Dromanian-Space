import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import pngToIco from 'png-to-ico';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(scriptDirectory, '..');
const assetDirectory = path.join(projectDirectory, 'desktop', 'assets');
const svgPath = path.join(assetDirectory, 'icon.svg');
const pngPath = path.join(assetDirectory, 'icon.png');
const icoPath = path.join(assetDirectory, 'icon.ico');

await mkdir(assetDirectory, { recursive: true });
const svg = await readFile(svgPath);
const rendered = new Resvg(svg, {
  fitTo: { mode: 'width', value: 512 },
  background: 'rgba(0, 0, 0, 0)',
}).render().asPng();
await writeFile(pngPath, rendered);
await writeFile(icoPath, await pngToIco(rendered));
console.log(`Desktop icons written to ${path.relative(projectDirectory, assetDirectory)}`);
