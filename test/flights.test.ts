import { describe, expect, it, vi } from "vitest";
import { Flights } from "../src/flights.js";

describe("Flights", () => {
  it("detaches the matching flights and calls their onDetach once", () => {
    const flights = new Flights();
    const onDetach = vi.fn();
    const matching = flights.track("get:/tickets/1", onDetach);
    const other = flights.track("get:/users/1");

    flights.detach((key) => key.startsWith("get:/tickets/"));
    flights.detach((key) => key.startsWith("get:/tickets/"));

    expect(matching.detached).toBe(true);
    expect(other.detached).toBe(false);
    expect(onDetach).toHaveBeenCalledTimes(1);
  });

  it("forgets a flight once it has landed", () => {
    const flights = new Flights();
    const onDetach = vi.fn();
    const flight = flights.track("get:/tickets/1", onDetach);

    flight.land();
    flight.land();
    flights.detach(() => true);

    expect(flight.detached).toBe(false);
    expect(onDetach).not.toHaveBeenCalled();
  });

  it("keeps the other flights of a key when one of them lands", () => {
    const flights = new Flights();
    const landed = flights.track("get:/tickets/1");
    const flying = flights.track("get:/tickets/1");

    landed.land();
    flights.detach(() => true);

    expect(flying.detached).toBe(true);
  });
});
