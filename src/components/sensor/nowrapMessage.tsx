import type { ReactNode } from 'react'

const MARK = '\u0001'

/**
 * A message with each interpolated value kept on one line: the message is rendered with markers
 * in place of the values, then split, so the translation still owns the words and their order.
 */
export function nowrapMessage<K extends string>(
  message: (inputs: Record<K, string>) => string,
  values: Record<K, string>,
): ReactNode[] {
  const marks = Object.fromEntries(
    Object.keys(values).map((key) => [key, `${MARK}${key}${MARK}`]),
  ) as Record<K, string>
  return message(marks)
    .split(MARK)
    .map((part, i) =>
      i % 2 === 0 ? (
        part
      ) : (
        // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed message
        <span key={i} className="whitespace-nowrap">
          {values[part as K]}
        </span>
      ),
    )
}
