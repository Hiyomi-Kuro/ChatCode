import assert from "node:assert/strict"
import { test } from "node:test"
import { classifyGradleDiagnostics } from "../apps/server/core/android.mjs"

test("Gradle diagnostics retain source locations and error categories from real log shapes", () => {
  const log = [
    "Build file 'D:\\Download\\ChatCode\\Calculator\\app\\build.gradle.kts' line: 17",
    "e: file:///D:/Download/ChatCode/Calculator/app/src/main/java/com/example/calculator/MainActivity.kt: (41, 19): Unresolved reference: colorSurface",
    "D:\\Download\\ChatCode\\Calculator\\app\\src\\main\\java\\com\\example\\calculator\\CalculatorEngine.java:27: error: cannot find symbol",
    "Android resource linking failed",
    "Could not resolve com.android.tools.build:gradle:8.13.2",
    "SDK location not found. Define a valid SDK location with an ANDROID_HOME environment variable.",
    "Unsupported class file major version 69",
    "Plugin [id: 'com.android.application'] was not found in any of the following sources:",
    "D8: Cannot fit requested classes in a single dex file",
  ].join("\n")
  const result = classifyGradleDiagnostics(log)
  assert.deepEqual(new Set(result.categories), new Set([
    "groovy_kotlin_dsl", "kotlin_compile", "java_compile", "resource_linking",
    "dependency_resolution", "sdk_configuration", "java_home", "gradle_plugin", "dex",
  ]))
  const gradleDsl = result.diagnostics.find((item) => item.type === "groovy_kotlin_dsl")
  assert.equal(gradleDsl.line, 17)
  assert.match(gradleDsl.file, /app\\build\.gradle\.kts$/)
  const kotlin = result.diagnostics.find((item) => item.type === "kotlin_compile")
  assert.equal(kotlin.line, 41)
  assert.equal(kotlin.column, 19)
  const java = result.diagnostics.find((item) => item.type === "java_compile")
  assert.equal(java.line, 27)
  assert.equal(java.column, null)
  assert.ok(result.diagnostics.every((item) => item.message.length <= 600 && item.severity === "error"))
})
