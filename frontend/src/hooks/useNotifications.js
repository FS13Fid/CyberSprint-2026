import { useEffect, useState } from "react";
import { errorMessage } from "../lib/errors.js";

// Browser push was retired; all opt-in reminders and session summaries use MAX.
export default function useNotifications({ profile, setProfile, notify, setSettingsError, loadProfile }) {
  const [maxBusy, setMaxBusy] = useState(false);
  const [maxReminderTime, setMaxReminderTime] = useState("20:00");

  useEffect(() => {
    if (profile?.max_reminder_time) setMaxReminderTime(profile.max_reminder_time);
  }, [profile?.max_reminder_time]);

  const connectMaxBot = async () => {
    setMaxBusy(true);
    setSettingsError("");
    const tab = window.open("about:blank", "_blank");
    try {
      const response = await fetch("/api/profile/max/link", { method: "POST", credentials: "same-origin" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(errorMessage(data, "Не удалось подключить MAX."));
      if (tab) tab.location.href = data.url;
      else window.location.assign(data.url);
      notify("Откройте бота MAX и нажмите «Начать», затем вернитесь в профиль.");
    } catch (error) {
      tab?.close();
      setSettingsError(error instanceof TypeError ? "Не удалось подключиться. Проверьте соединение." : error.message);
    } finally {
      setMaxBusy(false);
    }
  };

  const updateMaxSettings = async (changes = {}) => {
    if (!profile?.max_connected) return;
    setMaxBusy(true);
    setSettingsError("");
    const settings = {
      reminder_enabled: Boolean(profile.max_reminder_enabled),
      summaries_enabled: Boolean(profile.max_summaries_enabled),
      reminder_time: maxReminderTime,
      ...changes,
    };
    try {
      const response = await fetch("/api/profile/max/settings", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(errorMessage(data, "Не удалось сохранить настройки MAX."));
      setProfile(data);
      if (changes.reminder_enabled !== undefined) notify(changes.reminder_enabled ? "Напоминания MAX включены." : "Напоминания MAX выключены.");
      else if (changes.summaries_enabled !== undefined) notify(changes.summaries_enabled ? "Итоги тренировок будут приходить в MAX." : "Итоги тренировок в MAX выключены.");
      else notify("Настройки MAX сохранены.");
    } catch (error) {
      setSettingsError(error instanceof TypeError ? "Не удалось подключиться. Проверьте соединение." : error.message);
      await loadProfile();
    } finally {
      setMaxBusy(false);
    }
  };

  const disconnectMaxBot = async () => {
    setMaxBusy(true);
    setSettingsError("");
    try {
      const response = await fetch("/api/profile/max", { method: "DELETE", credentials: "same-origin" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(errorMessage(data, "Не удалось отключить MAX."));
      setProfile(data);
      notify("MAX отключён от профиля.");
    } catch (error) {
      setSettingsError(error instanceof TypeError ? "Не удалось подключиться. Проверьте соединение." : error.message);
    } finally {
      setMaxBusy(false);
    }
  };

  return { maxBusy, maxReminderTime, setMaxReminderTime, connectMaxBot, updateMaxSettings, disconnectMaxBot };
}
