import { app } from "./app";

const port = process.env.PORT ?? 3000;

app.listen(port, () => {
  console.log(`Listening on 0.0.0.0:${port}`);
});
