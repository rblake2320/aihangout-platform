export function parseApiDate(value: string | Date | null | undefined): Date {
  if (value instanceof Date) return value
  if (!value) return new Date(Number.NaN)

  const normalized = /Z$|[+-]\d{2}:\d{2}$/.test(value)
    ? value
    : `${value.replace(' ', 'T')}Z`

  return new Date(normalized)
}
