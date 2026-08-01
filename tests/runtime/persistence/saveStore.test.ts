import { expect, it } from "vitest";
import {
  sortAutosaveSummaries,
  sortCheckpointSummaries,
  sortCitySummaries,
} from "../../../src/persistence/saveStore";
import {
  makeAutosaveSummary,
  makeCheckpointSummary,
  makeCitySummary,
} from "./fixtures";

it("sorts cities by save time then ID and places invalid times last", () => {
  expect(
    sortCitySummaries([
      makeCitySummary({
        cityId: "b",
        savedAt: "2026-08-01T10:00:00.000Z",
      }),
      makeCitySummary({
        cityId: "a",
        savedAt: "2026-08-01T10:00:00.000Z",
      }),
      makeCitySummary({ cityId: "z", savedAt: null }),
    ]).map((value) => value.cityId),
  ).toEqual(["a", "b", "z"]);
});

it("sorts checkpoints by creation time then ID and places invalid times last", () => {
  expect(
    sortCheckpointSummaries([
      makeCheckpointSummary({
        checkpointId: "b",
        createdAt: "2026-08-01T10:00:00.000Z",
      }),
      makeCheckpointSummary({
        checkpointId: "a",
        createdAt: "2026-08-01T10:00:00.000Z",
      }),
      makeCheckpointSummary({
        checkpointId: "z",
        createdAt: "not-a-timestamp",
      }),
    ]).map((value) => value.checkpointId),
  ).toEqual(["a", "b", "z"]);
});

it("sorts autosaves by generation then ID", () => {
  expect(
    sortAutosaveSummaries([
      makeAutosaveSummary({ autosaveId: "b", generation: 2 }),
      makeAutosaveSummary({ autosaveId: "a", generation: 2 }),
      makeAutosaveSummary({ autosaveId: "z", generation: 1 }),
    ]).map((value) => value.autosaveId),
  ).toEqual(["a", "b", "z"]);
});

it("does not mutate caller-owned summary arrays", () => {
  const cities = [
    makeCitySummary({ cityId: "older", savedAt: "2026-08-01T09:00:00.000Z" }),
    makeCitySummary({ cityId: "newer", savedAt: "2026-08-01T10:00:00.000Z" }),
  ];
  const checkpoints = [
    makeCheckpointSummary({
      checkpointId: "older",
      createdAt: "2026-08-01T09:00:00.000Z",
    }),
    makeCheckpointSummary({
      checkpointId: "newer",
      createdAt: "2026-08-01T10:00:00.000Z",
    }),
  ];
  const autosaves = [
    makeAutosaveSummary({ autosaveId: "older", generation: 1 }),
    makeAutosaveSummary({ autosaveId: "newer", generation: 2 }),
  ];

  sortCitySummaries(cities);
  sortCheckpointSummaries(checkpoints);
  sortAutosaveSummaries(autosaves);

  expect(cities.map((value) => value.cityId)).toEqual(["older", "newer"]);
  expect(checkpoints.map((value) => value.checkpointId)).toEqual([
    "older",
    "newer",
  ]);
  expect(autosaves.map((value) => value.autosaveId)).toEqual([
    "older",
    "newer",
  ]);
});

it("sorts equal-timestamp cities with ascending input IDs into ascending order", () => {
  expect(
    sortCitySummaries([
      makeCitySummary({
        cityId: "city-a",
        savedAt: "2026-08-01T10:00:00.000Z",
      }),
      makeCitySummary({
        cityId: "city-b",
        savedAt: "2026-08-01T10:00:00.000Z",
      }),
      makeCitySummary({
        cityId: "city-c",
        savedAt: "2026-08-01T10:00:00.000Z",
      }),
    ]).map((value) => value.cityId),
  ).toEqual(["city-a", "city-b", "city-c"]);
});

it("treats equal city IDs as a stable tie", () => {
  expect(
    sortCitySummaries([
      makeCitySummary({
        cityId: "city-same",
        savedAt: "2026-08-01T10:00:00.000Z",
      }),
      makeCitySummary({
        cityId: "city-same",
        savedAt: "2026-08-01T10:00:00.000Z",
      }),
    ]).map((value) => value.cityId),
  ).toEqual(["city-same", "city-same"]);
});

it("ranks two cities with invalid timestamps by ID", () => {
  expect(
    sortCitySummaries([
      makeCitySummary({ cityId: "city-b", savedAt: "not-a-timestamp" }),
      makeCitySummary({ cityId: "city-a", savedAt: "also-invalid" }),
    ]).map((value) => value.cityId),
  ).toEqual(["city-a", "city-b"]);
});

it("ranks a valid timestamp before an invalid timestamp regardless of input order", () => {
  expect(
    sortCitySummaries([
      makeCitySummary({ cityId: "city-invalid", savedAt: "not-a-timestamp" }),
      makeCitySummary({
        cityId: "city-valid",
        savedAt: "2026-08-01T10:00:00.000Z",
      }),
    ]).map((value) => value.cityId),
  ).toEqual(["city-valid", "city-invalid"]);
});

it("ranks a valid timestamp before a null timestamp", () => {
  expect(
    sortCitySummaries([
      makeCitySummary({ cityId: "city-null", savedAt: null }),
      makeCitySummary({
        cityId: "city-valid",
        savedAt: "2026-08-01T10:00:00.000Z",
      }),
    ]).map((value) => value.cityId),
  ).toEqual(["city-valid", "city-null"]);
});

it("ranks two null-timestamp cities by ID", () => {
  expect(
    sortCitySummaries([
      makeCitySummary({ cityId: "city-b", savedAt: null }),
      makeCitySummary({ cityId: "city-a", savedAt: null }),
    ]).map((value) => value.cityId),
  ).toEqual(["city-a", "city-b"]);
});
