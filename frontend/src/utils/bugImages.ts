export interface BugImage { name: string; dataUrl: string }
export async function prepareBugImage(file: File): Promise<BugImage> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Choose a PNG, JPEG or WebP image.');
  if (!file.size || file.size > 10 * 1024 * 1024) throw new Error('Choose an image smaller than 10 MB.');
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    if (!image.naturalWidth || image.naturalWidth * image.naturalHeight > 40_000_000) throw new Error('This image is too large. Crop or resize it first.');
    const canvas = document.createElement('canvas')
    let scale = Math.min(1, 2000 / Math.max(image.naturalWidth, image.naturalHeight))
    for (let attempt = 0; attempt < 4; attempt++) {
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
      const context = canvas.getContext('2d')
      if (!context) throw new Error('This browser could not prepare the screenshot.');
      context.fillStyle = '#fff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85 - attempt * 0.1)
      if (dataUrl.length <= 699075) return { name: `${file.name.replace(/\.[^.]*$/, '').slice(0, 100) || 'Screenshot'}.jpg`, dataUrl }
      scale *= 0.75
    }
    throw new Error('This screenshot is still too large. Crop it and try again.')
  } catch (error) {
    throw new Error(error instanceof Error && error.name !== 'EncodingError' ? error.message : 'This image could not be opened. Try another PNG, JPEG or WebP file.')
  } finally { URL.revokeObjectURL(url) }
}
