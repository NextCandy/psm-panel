// wrangler imports .sql files as text
declare module '*.sql' {
  const sql: string
  export default sql
}
