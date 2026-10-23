import { parentPort, workerData } from "node:worker_threads"

const flags = workerData.caseSensitive ? "u" : "iu"
const expression = new RegExp(workerData.pattern, flags)
const matches = []
const lines = workerData.text.split(/\r\n|\n|\r/)
for (let index = 0; index < lines.length && matches.length < workerData.maxMatches; index++) {
  if (expression.test(lines[index])) matches.push({ line: index + 1, text: lines[index].slice(0, 300) })
}
parentPort.postMessage(matches)
