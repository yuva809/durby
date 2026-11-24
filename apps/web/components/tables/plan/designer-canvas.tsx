'use client';

import {
  type DiningTable,
  FLOOR_PLAN_SNAP,
  type FloorPlanBox,
  overlappingTables,
} from '@durby/shared';
import { type Dispatch, type KeyboardEvent, type PointerEvent, useRef } from 'react';
import { useT } from '../../../app/labels-provider';
import type { EditorAction, EditorState } from '../../../lib/pos/plan-editor';
import { cn } from '../../../lib/utils';
import { boxStyle, PieceShape, PlanCanvas, TableShapeBox } from './plan-canvas';

interface Gesture {
  key: string;
  mode: 'move' | 'resize';
  pointer: number;
  /** Where the pointer went down, in CSS pixels, and the item's box then. */
  x: number;
  y: number;
  box: FloorPlanBox;
}

const ARROWS: Record<string, readonly [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/** The canvas to edit on: drag, resize at the corner, arrow keys, Delete (ADR 0073). */
export function DesignerCanvas({
  state,
  dispatch,
  tables,
}: {
  state: EditorState;
  dispatch: Dispatch<EditorAction>;
  tables: ReadonlyMap<string, DiningTable>;
}) {
  const t = useT();
  const canvas = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const { layout, selected } = state;
  const overlaps = overlappingTables(layout);

  function down(event: PointerEvent, item: FloorPlanBox & { key: string }, mode: Gesture['mode']) {
    if (event.button !== 0 || gesture.current) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = {
      key: item.key,
      mode,
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      box: { x: item.x, y: item.y, width: item.width, height: item.height },
    };
    dispatch({ type: 'dragStart', key: item.key });
  }

  function move(event: PointerEvent) {
    const g = gesture.current;
    const bounds = canvas.current?.getBoundingClientRect();
    if (g?.pointer !== event.pointerId || !bounds || bounds.width === 0) return;
    // The canvas keeps the room's proportions, so one factor does for both ways.
    const scale = layout.room.width / bounds.width;
    const dx = (event.clientX - g.x) * scale;
    const dy = (event.clientY - g.y) * scale;
    dispatch({
      type: 'place',
      key: g.key,
      box:
        g.mode === 'move'
          ? { x: g.box.x + dx, y: g.box.y + dy }
          : { width: g.box.width + dx, height: g.box.height + dy },
    });
  }

  function end(event: PointerEvent, type: 'dragEnd' | 'dragCancel') {
    if (gesture.current?.pointer !== event.pointerId) return;
    gesture.current = null;
    dispatch({ type });
  }

  function keyDown(event: KeyboardEvent, item: FloorPlanBox & { key: string }) {
    const arrow = ARROWS[event.key];
    if (arrow) {
      event.preventDefault();
      // Alt: single units, past the grid.
      const step = event.altKey ? 1 : FLOOR_PLAN_SNAP;
      dispatch({
        type: 'place',
        key: item.key,
        box: { x: item.x + arrow[0] * step, y: item.y + arrow[1] * step },
        exact: event.altKey,
      });
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      dispatch({ type: 'remove', key: item.key });
    } else if (event.key === 'Escape') {
      dispatch({ type: 'select', key: null });
    }
  }

  const common = (item: FloorPlanBox & { key: string }, name: string) => ({
    key: item.key,
    type: 'button' as const,
    style: boxStyle(item, layout.room),
    'data-testid': 'plan-item',
    'data-key': item.key,
    'aria-label': name,
    'aria-pressed': selected === item.key,
    className: cn(
      'cursor-grab touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing',
      selected === item.key && 'z-10 ring-2 ring-primary ring-offset-2',
    ),
    onFocus: () => dispatch({ type: 'select', key: item.key }),
    onPointerDown: (event: PointerEvent) => down(event, item, 'move'),
    onPointerMove: move,
    onPointerUp: (event: PointerEvent) => end(event, 'dragEnd'),
    onPointerCancel: (event: PointerEvent) => end(event, 'dragCancel'),
    onKeyDown: (event: KeyboardEvent) => keyDown(event, item),
  });

  // Its events bubble through the item, which does the moving; the corner only says that this is a resize.
  const corner = (item: FloorPlanBox & { key: string }, name: string) =>
    selected === item.key ? (
      <span
        title={t('pos.plan.resize', { name })}
        data-testid="plan-resize"
        className="absolute -right-2 -bottom-2 size-5 cursor-nwse-resize touch-none rounded-full border-2 border-primary bg-background"
        onPointerDown={(event) => down(event, item, 'resize')}
      />
    ) : null;

  return (
    <PlanCanvas
      layout={layout}
      label={t('pos.plan.canvas')}
      canvasRef={canvas}
      onBackground={() => dispatch({ type: 'select', key: null })}
    >
      {layout.pieces.map((piece) => {
        const name = t(`pos.plan.pieces.${piece.kind}`);
        const { key, ...props } = common(piece, name);
        return (
          <button key={key} {...props} data-kind={piece.kind}>
            <PieceShape kind={piece.kind} />
            {corner(piece, name)}
          </button>
        );
      })}
      {layout.tables.map((item) => {
        const table = item.tableId ? tables.get(item.tableId) : undefined;
        const look = table ?? item.create;
        if (!look) return null;
        const { key, ...props } = common(item, look.name);
        return (
          <button key={key} {...props} data-overlap={overlaps.has(item.key) || undefined}>
            <TableShapeBox
              shape={look.shape}
              color={table?.color ?? 'neutral'}
              className={cn(
                item.create && 'border-dashed',
                overlaps.has(item.key) && 'outline-2 outline-destructive outline-dashed',
              )}
            >
              <span className="text-sm font-semibold">{look.name}</span>
              <span className="text-xs text-muted-foreground">{look.seats}</span>
            </TableShapeBox>
            {corner(item, look.name)}
          </button>
        );
      })}
    </PlanCanvas>
  );
}
