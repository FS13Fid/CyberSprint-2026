import React from "react";

export default function SpeedUnitSwitch({ value, onChange }) {
  return <div className="unit-switch" role="group" aria-label="Единица измерения скорости">
    <button type="button" className={value === "wpm" ? "selected" : ""} aria-pressed={value === "wpm"} onClick={() => onChange("wpm")}>Слова/мин</button>
    <button type="button" className={value === "cpm" ? "selected" : ""} aria-pressed={value === "cpm"} onClick={() => onChange("cpm")}>Знаки/мин</button>
  </div>;
}
