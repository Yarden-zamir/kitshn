import http from "node:http";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  response.end("__RECIPE__ is running\n");
});

server.listen(port, "0.0.0.0", () => {
  console.log(`listening on ${port}`);
});
