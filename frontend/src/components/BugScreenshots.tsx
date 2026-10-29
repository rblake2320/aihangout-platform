import type { BugImage } from '../utils/bugImages'
export default function BugScreenshots({ images, disabled, busy, onFiles, onRemove }: {
  images: BugImage[]; disabled: boolean; busy: boolean;
  onFiles: (files: File[]) => void; onRemove: (index: number) => void
}) {
  return <section aria-label="Screenshot attachments" className="rounded-lg border border-dashed border-gray-300 p-4 space-y-3" tabIndex={0}>
    <h2 className="font-medium text-gray-900">Screenshots</h2>
    <p className="text-sm text-gray-600">Paste an image anywhere in this form, or choose images from your phone or computer. Up to 3 PNG, JPEG or WebP images, 10 MB each. Images are resized for submission.</p>
    <label className="block text-sm font-medium" htmlFor="bug-screenshots">Choose screenshots</label>
    <input id="bug-screenshots" type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={disabled || busy || images.length >= 3}
      className="block w-full text-sm" onChange={event => { onFiles(Array.from(event.target.files || [])); event.target.value = '' }} />
    <p role="status" className="text-sm text-gray-600">{busy ? 'Preparing screenshots…' : `${images.length} of 3 screenshots attached`}</p>
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">{images.map((image, index) => <figure key={`${index}-${image.name}`} className="rounded border p-2 min-w-0">
      <img src={image.dataUrl} alt={`Attached screenshot ${index + 1}`} className="w-full h-36 object-contain" />
      <figcaption className="text-xs break-words mt-1">{image.name}</figcaption>
      <button type="button" disabled={disabled || busy} onClick={() => onRemove(index)} className="text-sm text-red-700 underline mt-2" aria-label={`Remove screenshot ${index + 1}`}>Remove</button>
    </figure>)}</div>
  </section>
}
