/** Log sink port. Events carry ids, codes and counts only; never a token, header or response body. */
export type AuthLog = (event: string, fields: Record<string, string | number | boolean | null>) => void;
export const noLog: AuthLog = () => {};
