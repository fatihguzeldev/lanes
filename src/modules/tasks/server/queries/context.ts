export interface TaskQueriesOptions {
  boardListSelection?:
    | ((
        accountId: string,
        boardId: string,
      ) => Promise<{ sql: string; bindings: (string | number)[] }>)
    | undefined;
}

export interface TaskQueryContext {
  today: string;
  now?: number | undefined;
}
