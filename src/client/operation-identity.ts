export const newOperationId = (clockOffset = 0) =>
  `${Math.floor(Date.now() + clockOffset)}:${crypto.randomUUID().replaceAll('-', '')}`;
