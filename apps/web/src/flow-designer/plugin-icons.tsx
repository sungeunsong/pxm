import React from 'react';
import {
  CheckSquare,
  CircleCheck,
  ClipboardList,
  Braces,
  Clock,
  Cpu,
  Database,
  Diamond,
  Globe,
  MessageSquare,
  Play,
  Search,
  ShieldCheck,
  Shuffle,
  Square,
  Ticket,
  UserPlus,
  UserSearch,
  Users,
} from 'lucide-react';

const iconMap: Record<string, React.ComponentType<{ size?: number; fill?: string; style?: React.CSSProperties }>> = {
  'check-square': CheckSquare,
  'circle-check': CircleCheck,
  'clipboard-list': ClipboardList,
  clock: Clock,
  cpu: Cpu,
  database: Database,
  diamond: Diamond,
  globe: Globe,
  'message-square': MessageSquare,
  play: Play,
  search: Search,
  'shield-check': ShieldCheck,
  shuffle: Shuffle,
  square: Square,
  ticket: Ticket,
  'user-plus': UserPlus,
  'user-search': UserSearch,
  users: Users,
  braces: Braces,
};

export function PluginIcon({
  icon,
  size = 16,
}: {
  icon?: string;
  size?: number;
}) {
  const Icon = icon ? iconMap[icon] : undefined;
  if (!Icon) {
    return <Cpu size={size} />;
  }
  return <Icon size={size} />;
}

export function nodeTypeIcon(nodeType: string, icon?: string) {
  if (icon) {
    return <PluginIcon icon={icon} size={15} />;
  }

  switch (nodeType) {
    case 'start':
      return <Play size={15} fill="currentColor" style={{ marginLeft: '1px' }} />;
    case 'service':
      return <Cpu size={15} />;
    case 'script':
      return <Braces size={15} />;
    case 'timer':
      return <Clock size={15} />;
    case 'gateway':
      return <Diamond size={15} fill="currentColor" />;
    case 'approval':
      return <CheckSquare size={15} />;
    case 'end':
      return <CircleCheck size={15} />;
    default:
      return null;
  }
}
