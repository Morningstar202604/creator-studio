import { useMemo, useState } from 'react';
import type React from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';

/**
 * Board columns with drag-and-drop.
 *
 * Dragging is delegated to dnd-kit rather than written by hand: pointer capture,
 * collision detection and the keyboard path (focus the handle, space to pick up,
 * arrows to move, space to drop) are all things a hand-rolled version gets wrong.
 * The board only decides what a drop *means*: which column the card now belongs to
 * and where it sits inside that column.
 *
 * The drag handle is its own button so a plain click still opens the card — if the
 * whole card were an activator, every click would start a drag.
 */

export type BoardCard = { id: string; title: string; summary: string };

export type BoardColumn = { value: string; label: string; cards: BoardCard[] };

type DropTarget = { column: string; index: number };

export function KanbanBoard({
  columns,
  onMove,
  onOpen,
}: {
  columns: BoardColumn[];
  /** Called with the destination column value and the index inside it. */
  onMove: (cardId: string, column: string, index: number) => void;
  onOpen: (cardId: string) => void;
}): React.ReactElement {
  const [dragging, setDragging] = useState<BoardCard | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );

  const cardsById = useMemo(() => {
    const map = new Map<string, BoardCard>();
    for (const column of columns) for (const card of column.cards) map.set(card.id, card);
    return map;
  }, [columns]);

  const handleEnd = (event: DragEndEvent): void => {
    setDragging(null);
    const over = event.over;
    if (over === null) return;
    const target = over.data.current as DropTarget | undefined;
    if (target === undefined) return;
    onMove(String(event.active.id), target.column, target.index);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={(event: DragStartEvent) => setDragging(cardsById.get(String(event.active.id)) ?? null)}
      onDragCancel={() => setDragging(null)}
      onDragEnd={handleEnd}
    >
      <div className="kanban">
        {columns.map((column) => (
          <Column key={column.value} column={column} onOpen={onOpen} />
        ))}
      </div>
      <DragOverlay dropAnimation={null}>
        {dragging === null ? null : (
          <div className="kanban-card dragging">
            <span>{dragging.title}</span>
            <span className="hint">{dragging.summary}</span>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

function Column({
  column,
  onOpen,
}: {
  column: BoardColumn;
  onOpen: (cardId: string) => void;
}): React.ReactElement {
  const { setNodeRef, isOver } = useDroppable({
    id: `column:${column.value}`,
    data: { column: column.value, index: column.cards.length } satisfies DropTarget,
  });

  return (
    <section ref={setNodeRef} className={`kanban-column${isOver ? ' over' : ''}`} aria-label={column.label}>
      <div className="kanban-head">
        <span>{column.label}</span>
        <span className="hint">{column.cards.length}</span>
      </div>
      {column.cards.map((card, index) => (
        <Card key={card.id} card={card} column={column.value} index={index} onOpen={onOpen} />
      ))}
      {column.cards.length === 0 && <p className="hint">拖到这里</p>}
    </section>
  );
}

function Card({
  card,
  column,
  index,
  onOpen,
}: {
  card: BoardCard;
  column: string;
  index: number;
  onOpen: (cardId: string) => void;
}): React.ReactElement {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging } = useDraggable({
    id: card.id,
    data: { column, index } satisfies DropTarget,
  });
  const { setNodeRef: setDropRef } = useDroppable({
    id: `card:${card.id}`,
    data: { column, index } satisfies DropTarget,
  });

  return (
    <div
      ref={(node) => {
        setNodeRef(node);
        setDropRef(node);
      }}
      className={`kanban-card${isDragging ? ' is-dragging' : ''}`}
      style={{ transform: CSS.Translate.toString(transform) }}
    >
      <button
        type="button"
        className="kanban-grip"
        aria-label={`拖动 ${card.title}`}
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
      >
        ⋮⋮
      </button>
      <button type="button" className="kanban-open" onClick={() => onOpen(card.id)}>
        <span>{card.title}</span>
        {card.summary === '' ? null : <span className="hint">{card.summary}</span>}
      </button>
    </div>
  );
}
