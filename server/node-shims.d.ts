declare module 'node:http' {
  export function createServer(handler: (request: any, response: any) => void | Promise<void>): any
}

declare module 'node:crypto' {
  export function randomUUID(): string
}
