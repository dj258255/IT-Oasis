import { createClient } from "tinacms/dist/client";
import { queries } from "./types";
export const client = createClient({ url: 'http://localhost:4001/graphql', token: '79d3c8cb6b05c739683dd457d45c101eea87c341', queries,  });
export default client;
  