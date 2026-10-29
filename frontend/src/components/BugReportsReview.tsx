import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { bugReportAPI } from '../services/api'

export default function BugReportsReview() {
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const reports = useQuery({ queryKey: ['admin-bug-reports'], queryFn: () => bugReportAPI.list({ limit: 50 }) })
  const detail = useQuery({ queryKey: ['admin-bug-report', selectedId], queryFn: () => bugReportAPI.get(selectedId!), enabled: selectedId !== null })
  const report = detail.data?.data?.bugReport
  const images = detail.data?.data?.images || []
  return <section className="space-y-4" aria-label="Bug reports">
    {reports.isLoading && <p>Loading bug reports…</p>}
    {reports.isError && <p role="alert">Could not load bug reports. <button onClick={() => reports.refetch()} className="underline">Retry</button></p>}
    {reports.data?.data?.bugReports?.length === 0 && <p>No bug reports yet.</p>}
    <div className="space-y-2">{reports.data?.data?.bugReports?.map((item: any) => <button key={item.id} onClick={() => setSelectedId(item.id)} className="block w-full rounded border bg-white p-3 text-left">
      <span className="font-medium">#{item.id}: {item.title}</span>
      <span className="block text-sm text-gray-600">{item.status} · {item.priority} · {item.image_count || 0} screenshots</span>
    </button>)}</div>
    {detail.isFetching && <p role="status">Loading report…</p>}
    {detail.isError && <p role="alert">Could not load this report. <button onClick={() => detail.refetch()} className="underline">Retry</button></p>}
    {report && <article className="rounded border bg-white p-4 space-y-4">
      <h2 className="text-xl font-semibold">#{report.id}: {report.title}</h2>
      <p className="whitespace-pre-wrap break-words">{report.description}</p>
      {[['Steps to reproduce', report.steps_to_reproduce], ['Expected', report.expected_behavior], ['Actual', report.actual_behavior], ['Additional information', report.additional_info]].map(([label, value]) => value && <div key={label}><h3 className="font-medium">{label}</h3><p className="whitespace-pre-wrap break-words">{value}</p></div>)}
      <div className="space-y-4">{images.map((image: any, index: number) => <figure key={image.id} className="rounded border p-2">
        <img src={image.dataUrl} alt={`Bug report screenshot ${index + 1}`} className="max-w-full h-auto" />
        <figcaption className="text-sm text-gray-600 break-words">{image.name} · {Math.ceil(image.byteLength / 1024)} KB</figcaption>
      </figure>)}</div>
    </article>}
  </section>
}
