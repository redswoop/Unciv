/// <reference types="vite/client" />

declare module "*?raw" {
  const text: string;
  export default text;
}

declare module "*?inline" {
  const dataUri: string;
  export default dataUri;
}
