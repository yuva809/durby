import type { TableColor, TableShape } from '@durby/shared';
import { cn } from '../../lib/utils';

/** The colour tokens of a table (app/globals.css → Table colours). */
export function tableColors(color: TableColor): { stroke: string; fill: string } {
  return { stroke: `var(--table-${color})`, fill: `var(--table-${color}-soft)` };
}

/**
 * A table seen from above in its shape and colour, with chairs, like the floor plan of the
 * tables page (docs/modules/pos.md). Decorative: the table's name is always shown next to it.
 */
export function TableIcon({
  shape,
  color,
  className,
}: {
  shape: TableShape;
  color: TableColor;
  className?: string;
}) {
  const { stroke, fill } = tableColors(color);
  const chair = { fill: stroke, rx: 1.5 };
  return (
    <svg
      viewBox="0 0 48 48"
      aria-hidden
      className={cn('size-12 shrink-0', className)}
      data-shape={shape}
      data-color={color}
    >
      {shape === 'round' && (
        <>
          <circle cx="24" cy="24" r="11" fill={fill} stroke={stroke} strokeWidth="2.5" />
          <rect x="21" y="5" width="6" height="4" {...chair} />
          <rect x="21" y="39" width="6" height="4" {...chair} />
          <rect x="5" y="21" width="4" height="6" {...chair} />
          <rect x="39" y="21" width="4" height="6" {...chair} />
        </>
      )}
      {shape === 'square' && (
        <>
          <rect
            x="13"
            y="13"
            width="22"
            height="22"
            rx="4"
            fill={fill}
            stroke={stroke}
            strokeWidth="2.5"
          />
          <rect x="18" y="5" width="12" height="4" {...chair} />
          <rect x="18" y="39" width="12" height="4" {...chair} />
          <rect x="5" y="18" width="4" height="12" {...chair} />
          <rect x="39" y="18" width="4" height="12" {...chair} />
        </>
      )}
      {shape === 'long' && (
        <>
          <rect
            x="6"
            y="16"
            width="36"
            height="16"
            rx="4"
            fill={fill}
            stroke={stroke}
            strokeWidth="2.5"
          />
          <rect x="11" y="9" width="10" height="4" {...chair} />
          <rect x="27" y="9" width="10" height="4" {...chair} />
          <rect x="11" y="35" width="10" height="4" {...chair} />
          <rect x="27" y="35" width="10" height="4" {...chair} />
        </>
      )}
    </svg>
  );
}
