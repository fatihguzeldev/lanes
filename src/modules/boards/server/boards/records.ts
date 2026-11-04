import { type Board, type BoardMembership } from '../../contracts/board';
export interface BoardRow {
  id: string;
  account_id: string;
  title: string;
  is_main: number;
  emoji: string | null;
  color: string;
  background_url: string | null;
  position: number;
  revision: number;
  created_at: number;
}

export interface MembershipRow {
  account_id: string;
  list_id: string;
  board_id: string;
  color: string;
  position: number;
  revision: number;
}

export const boardFields =
  'id,account_id,title,is_main,emoji,color,background_url,position,revision,created_at';

export const membershipFields = 'account_id,list_id,board_id,color,position,revision';

export function board(row: BoardRow): Board {
  return {
    id: row.id,
    accountId: row.account_id,
    title: row.title,
    isMain: row.is_main === 1,
    emoji: row.emoji,
    color: row.color,
    backgroundUrl: row.background_url,
    position: row.position,
    revision: row.revision,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export function membership(row: MembershipRow): BoardMembership {
  return {
    accountId: row.account_id,
    listId: row.list_id,
    boardId: row.board_id,
    color: row.color,
    position: row.position,
    revision: row.revision,
  };
}
