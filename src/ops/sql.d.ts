// `*.sql` files are imported as text (wrangler [[rules]] type = "Text").
declare module "*.sql" {
  const content: string;
  export default content;
}
