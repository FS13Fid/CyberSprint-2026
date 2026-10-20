import React from "react";

export default function Sparkline({ values, color = "#315846" }) {
  if (!values.length) return <div className="chart-empty">Тренировок пока нет</div>;
  const width = 580;
  const height = 160;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values.map((value, index) => {
    const x = values.length === 1 ? width / 2 : (index / (values.length - 1)) * width;
    const y = height - 12 - ((value - min) / range) * (height - 24);
    return `${x},${y}`;
  }).join(" ");
  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="График результатов тренировок">
      <line x1="0" x2={width} y1={height - 1} y2={height - 1} className="chart-axis" />
      <polyline points={points} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      {values.map((value, index) => {
        const x = values.length === 1 ? width / 2 : (index / (values.length - 1)) * width;
        const y = height - 12 - ((value - min) / range) * (height - 24);
        return <circle key={`${index}-${value}`} cx={x} cy={y} r="4" fill={color} />;
      })}
    </svg>
  );
}
