import { useState } from "react";
import { errorMessage } from "../lib/errors.js";

export default function useProfileSettings({ setProfile, notify }) {
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState("");

  const submitUsernameChange = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    setSettingsBusy(true);
    setSettingsError("");
    try {
      const response = await fetch("/api/profile/username", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: String(formData.get("username") || "").trim(),
          current_password: String(formData.get("current_password") || ""),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(errorMessage(data, "Не удалось изменить никнейм."));
      setProfile(data);
      form.elements.username.value = data.username;
      if (form.elements.current_password) form.elements.current_password.value = "";
      notify("Никнейм обновлён.");
    } catch (error) {
      setSettingsError(error instanceof TypeError ? "Не удалось подключиться. Проверьте соединение." : error.message);
    } finally {
      setSettingsBusy(false);
    }
  };

  const submitEmailChange = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    setSettingsBusy(true);
    setSettingsError("");
    try {
      const response = await fetch("/api/profile/email", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: String(formData.get("email") || "").trim(),
          current_password: String(formData.get("current_password") || ""),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(errorMessage(data, "Не удалось изменить email."));
      setProfile(data);
      form.elements.email.value = data.email;
      if (form.elements.current_password) form.elements.current_password.value = "";
      notify("Email обновлён.");
    } catch (error) {
      setSettingsError(error instanceof TypeError ? "Не удалось подключиться. Проверьте соединение." : error.message);
    } finally {
      setSettingsBusy(false);
    }
  };

  const submitPasswordChange = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    setSettingsBusy(true);
    setSettingsError("");
    try {
      const response = await fetch("/api/profile/password", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          current_password: String(formData.get("current_password") || ""),
          new_password: String(formData.get("new_password") || ""),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(errorMessage(data, "Не удалось изменить пароль."));
      form.reset();
      notify("Пароль изменён. Входы на других устройствах завершены.");
    } catch (error) {
      setSettingsError(error instanceof TypeError ? "Не удалось подключиться. Проверьте соединение." : error.message);
    } finally {
      setSettingsBusy(false);
    }
  };

  return { settingsBusy, settingsError, setSettingsError, submitUsernameChange, submitEmailChange, submitPasswordChange };
}
