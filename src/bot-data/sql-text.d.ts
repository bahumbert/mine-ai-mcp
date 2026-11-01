// `import schema from "./bot-data.sql" with { type: "text" }` gives the file's text (Bun reads it and the setup's bundle inlines it).
declare module "*.sql" {
  const text: string;
  export default text;
}
