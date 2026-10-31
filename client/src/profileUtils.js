import { normalizeUsername } from "./presence.js";

export const PROFILE_AVATAR_COLORS = [
  { name: "Violet", value: "#7250c7" },
  { name: "Blue", value: "#3265b3" },
  { name: "Teal", value: "#1f756f" },
  { name: "Coral", value: "#b44e48" },
  { name: "Amber", value: "#9b651b" },
];

export const AVAILABILITY_OPTIONS = [
  { value: "available", label: "Available" },
  { value: "away", label: "Away" },
  { value: "busy", label: "Busy" },
  { value: "dnd", label: "Do not disturb" },
];

export const DEFAULT_PROFILE = {
  displayName: "",
  avatarColor: PROFILE_AVATAR_COLORS[1].value,
  availability: "available",
};

export function normalizeProfile(profile = {}) {
  const allowedColors = PROFILE_AVATAR_COLORS.map((color) => color.value);
  const allowedAvailability = AVAILABILITY_OPTIONS.map((option) => option.value);

  return {
    displayName: normalizeUsername(profile.displayName).slice(0, 24),
    avatarColor: allowedColors.includes(profile.avatarColor)
      ? profile.avatarColor
      : DEFAULT_PROFILE.avatarColor,
    availability: allowedAvailability.includes(profile.availability)
      ? profile.availability
      : DEFAULT_PROFILE.availability,
  };
}

export function getAvailabilityLabel(value) {
  return AVAILABILITY_OPTIONS.find((option) => option.value === value)?.label
    || AVAILABILITY_OPTIONS[0].label;
}
