/** Saving dashboard charts as SVG (vector) or PNG (raster) files. */

/** Adds `<metadata>` (provenance JSON) right after the opening `<svg …>` tag. */
export function withSvgMetadata(svg: string, metadata: Record<string, unknown>): string {
  const openEnd = svg.indexOf('>') + 1;
  if (openEnd <= 0) return svg;
  const json = JSON.stringify(metadata).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `${svg.slice(0, openEnd)}<metadata id="webgrainy-provenance">${json}</metadata>${svg.slice(openEnd)}`;
}

/** Width and height from the SVG's viewBox (or width/height attributes). */
export function svgSize(svg: string): { width: number; height: number } {
  const vb = /viewBox="\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)\s*"/.exec(svg);
  if (vb) return { width: Number(vb[1]), height: Number(vb[2]) };
  const w = /\swidth="([\d.]+)"/.exec(svg);
  const h = /\sheight="([\d.]+)"/.exec(svg);
  return { width: w ? Number(w[1]) : 400, height: h ? Number(h[1]) : 300 };
}

/** Rasterises an SVG string to a PNG Blob at `scale` × its viewBox size (default 3 = print quality). */
export async function svgToPngBlob(svg: string, scale = 3): Promise<Blob> {
  const { width, height } = svgSize(svg);
  const sized = svg.replace('<svg ', `<svg width="${width}" height="${height}" `);
  const url = URL.createObjectURL(new Blob([sized], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.decoding = 'sync';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Could not render the chart image.'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas is not available.');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed.'))), 'image/png'),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}
