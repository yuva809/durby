'use client';

import type {
  FloorPlanBox,
  FloorPlanLayout,
  FloorPlanPiece,
  FloorPlanRoom,
  FloorPlanTable,
  TableColor,
  TableShape,
} from '@durby/shared';
import type { CSSProperties, ReactNode, Ref } from 'react';
import { useT } from '../../../app/labels-provider';
import { cn } from '../../../lib/utils';
import { tableColors } from '../../pos/table-icon';

/** Where a box is in its room, as CSS percentages: the plan scales with its container. */
export function boxStyle(box: FloorPlanBox, room: FloorPlanRoom): CSSProperties {
  return {
    position: 'absolute',
    left: `${(box.x / room.width) * 100}%`,
    top: `${(box.y / room.height) * 100}%`,
    width: `${(box.width / room.width) * 100}%`,
    height: `${(box.height / room.height) * 100}%`,
  };
}

const PIECE_LOOK: Record<FloorPlanPiece['kind'], string> = {
  wall: 'rounded-sm bg-foreground/60',
  door: 'rounded-sm border-2 border-dashed border-foreground/50 bg-background',
  bar: 'rounded-md border border-border bg-muted text-muted-foreground',
  decor: 'rounded-full border border-border bg-accent',
};

/** A wall, door, bar or decor piece, drawn to fill its box. */
export function PieceShape({
  kind,
  className,
}: {
  kind: FloorPlanPiece['kind'];
  className?: string;
}) {
  const t = useT();
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-full items-center justify-center overflow-hidden text-xs',
        PIECE_LOOK[kind],
        className,
      )}
    >
      {kind === 'bar' ? t('pos.plan.pieces.bar') : null}
    </span>
  );
}

/** A table seen from above, drawn to fill its box. */
export function TableShapeBox({
  shape,
  color,
  className,
  children,
}: {
  shape: TableShape;
  color: TableColor;
  className?: string;
  children: ReactNode;
}) {
  const { stroke, fill } = tableColors(color);
  return (
    <span
      data-shape={shape}
      className={cn(
        'flex size-full flex-col items-center justify-center overflow-hidden border-2 text-center leading-tight text-foreground',
        shape === 'round' ? 'rounded-[50%]' : 'rounded-lg',
        className,
      )}
      style={{ borderColor: stroke, backgroundColor: fill }}
    >
      {children}
    </span>
  );
}

/**
 * A floor plan drawn to scale (ADR 0073), shared by the designer, Tables and Service. At least as wide as a finger needs
 * for the smallest table; a narrower screen scrolls it sideways.
 */
export function PlanCanvas({
  layout,
  label,
  canvasRef,
  onBackground,
  children,
  testId = 'plan-canvas',
}: {
  layout: FloorPlanLayout;
  label: string;
  canvasRef?: Ref<HTMLDivElement>;
  onBackground?: () => void;
  children: ReactNode;
  testId?: string;
}) {
  const { width, height } = layout.room;
  return (
    <div className="overflow-x-auto rounded-2xl border border-border bg-card">
      <div
        ref={canvasRef}
        role="group"
        aria-label={label}
        data-testid={testId}
        className="relative mx-auto w-full touch-pan-x touch-pan-y"
        style={{
          aspectRatio: `${width} / ${height}`,
          minWidth: 900 * (width / Math.max(width, height)),
          // A deep room would be higher than any screen at full width.
          maxWidth: width >= height ? undefined : 1100 * (width / height),
          backgroundImage: 'radial-gradient(var(--border) 1px, transparent 1px)',
          backgroundSize: `${(50 / width) * 100}% ${(50 / height) * 100}%`,
        }}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) onBackground?.();
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** A plan to look at: pieces, and whatever each table shows (nothing: not drawn). */
export function PlanView({
  layout,
  label,
  renderTable,
  testId,
}: {
  layout: FloorPlanLayout;
  label: string;
  renderTable: (table: FloorPlanTable) => ReactNode;
  testId?: string;
}) {
  return (
    <PlanCanvas layout={layout} label={label} testId={testId}>
      {layout.pieces.map((piece) => (
        <span
          key={piece.key}
          style={boxStyle(piece, layout.room)}
          data-testid="plan-piece"
          data-kind={piece.kind}
        >
          <PieceShape kind={piece.kind} />
        </span>
      ))}
      {layout.tables.map((table) => {
        const content = renderTable(table);
        return content === null ? null : (
          <div
            key={table.key}
            style={boxStyle(table, layout.room)}
            data-testid="plan-table"
            data-key={table.key}
          >
            {content}
          </div>
        );
      })}
    </PlanCanvas>
  );
}
