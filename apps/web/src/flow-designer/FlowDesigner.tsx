import React, { useMemo, useState, useRef } from 'react';
import type { Node } from 'reactflow';
import type { Edge } from 'reactflow';
import { Braces, CheckSquare, CircleCheck, Clipboard, ClipboardPaste, Clock, Diamond, Inbox, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Play, Plus, Search, Star, Terminal, Workflow, X } from 'lucide-react';
import { Button } from '../components/Button';
import { Header } from '../components/Header';
import { Input } from '../components/Input';
import { useFeedback } from '../components/feedback/feedback-context';
import { errorMessage } from '../lib/error-message';
import { FlowCanvas } from './FlowCanvas';
import type { FlowCanvasRef } from './FlowCanvas';
import type { CustomNodeData, FormSchema } from './form-types';
import { NodePropertiesForm } from './NodePropertiesForm';
import type { NodePathSuggestion } from './NodePropertiesForm';
import { TemplateListModal } from './TemplateListModal';
import { ExecutionModal } from './ExecutionModal';
import { ExecutionPanel } from './ExecutionPanel';
import { HistoryListModal } from './HistoryListModal';
import { templatesApi } from '../api/templates';
import type { WorkflowTemplate } from '../api/templates';
import { authzApi, type PxmGroup } from '../api/authz';
import type { SessionUser } from '../api/session';
import { pluginsApi } from '../api/plugins';
import type { PluginManifest, PluginTestResponse } from '../api/plugins';
import { PluginIcon } from './plugin-icons';
import './FlowDesigner.css';

export interface FlowDesignerProps {
  children?: React.ReactNode;
  onSwitchToInbox?: () => void;
  onExitTrace?: () => void;
  initialMonitorInstanceId?: string;
  currentUser: SessionUser;
}

type DesignerTab = {
  tabId: string;
  templateId: string | null;
  templateName: string;
  templateVersion?: number;
  lifecycleStatus?: WorkflowTemplate['lifecycle_status'];
  activePublishedVersion?: number | null;
  hasUnpublishedChanges?: boolean;
  description: string;
  group: string;
  groupId: string;
  tags: string;
  versionNote: string;
  nodes: Node<CustomNodeData>[];
  edges: Edge[];
  isDirty: boolean;
  traceInstanceId?: string;
};

const INITIAL_DESIGNER_TAB_ID = 'designer-tab-initial';

type WorkflowClipboard = {
  sourceTabId: string;
  sourceTemplateName: string;
  copiedAt: string;
  nodes: Node<CustomNodeData>[];
  edges: Edge[];
};

export const FlowDesigner: React.FC<FlowDesignerProps> = ({ onSwitchToInbox, onExitTrace, initialMonitorInstanceId, currentUser }) => {
  const { toast, confirm: confirmDialog, prompt: promptDialog } = useFeedback();
  const [darkMode, setDarkMode] = useState(true);
  const [selectedNode, setSelectedNode] = useState<Node<CustomNodeData> | null>(null);
  const [canvasNodes, setCanvasNodes] = useState<Node<CustomNodeData>[]>([]);
  const [canvasEdges, setCanvasEdges] = useState<Edge[]>([]);
  const [currentTemplateId, setCurrentTemplateId] = useState<string | null>(null);
  const [currentTemplateName, setCurrentTemplateName] = useState<string>('');
  const [workflowDescription, setWorkflowDescription] = useState('');
  const [workflowGroup, setWorkflowGroup] = useState('');
  const [workflowGroupId, setWorkflowGroupId] = useState('');
  const [availableGroups, setAvailableGroups] = useState<PxmGroup[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(true);
  const [groupsError, setGroupsError] = useState<string | null>(null);
  const [workflowTags, setWorkflowTags] = useState('');
  const [workflowVersionNote, setWorkflowVersionNote] = useState('');
  const [isTemplateModalOpen, setIsTemplateModalOpen] = useState(false);
  const [isExecutionModalOpen, setIsExecutionModalOpen] = useState(false);
  const [isExecutionPanelOpen, setIsExecutionPanelOpen] = useState(false);
  const [isPropertiesPanelOpen, setIsPropertiesPanelOpen] = useState(false);
  // 팔레트는 기본 rail(아이콘)로 접어 캔버스를 넓게 쓴다. 선택은 기억한다.
  const [isPaletteOpen, setIsPaletteOpen] = useState(() => localStorage.getItem('pxm.designer.palette') === 'open');
  const [isHistoryModalOpen, setIsHistoryModalOpen] = useState(false);
  const [executionInstanceId, setExecutionInstanceId] = useState<string | null>(null);
  const [traceInstanceId, setTraceInstanceId] = useState<string | null>(null);
  const [executionFormSchema, setExecutionFormSchema] = useState<FormSchema | undefined>(undefined);
  const [plugins, setPlugins] = useState<PluginManifest[]>([]);
  const [pluginSearch, setPluginSearch] = useState('');
  const [isNodeTestRunning, setIsNodeTestRunning] = useState(false);
  const [nodeTestResult, setNodeTestResult] = useState<PluginTestResponse | null>(null);
  const [nodeTestError, setNodeTestError] = useState<string | null>(null);
  const [designerTabs, setDesignerTabs] = useState<DesignerTab[]>(() => [createBlankDesignerTab(INITIAL_DESIGNER_TAB_ID)]);
  const [activeDesignerTabId, setActiveDesignerTabId] = useState(INITIAL_DESIGNER_TAB_ID);
  const [workflowClipboard, setWorkflowClipboard] = useState<WorkflowClipboard | null>(null);
  const [favoritePluginIds, setFavoritePluginIds] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('pxm.favoritePlugins') || '[]');
    } catch {
      return [];
    }
  });
  const flowCanvasRef = useRef<FlowCanvasRef>(null);
  const importFileInputRef = useRef<HTMLInputElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const eventQueueRef = useRef<Array<{nodeId: string, status: 'pending' | 'running' | 'completed' | 'failed'}>>([]); 
  const isProcessingRef = useRef(false);
  const suppressCanvasDirtyRef = useRef(true);

  // SSE 연결 정리
  React.useEffect(() => {
    let cancelled = false;
    authzApi.listGroups(false, true)
      .then((groups) => { if (!cancelled) { setAvailableGroups(groups.filter((group) => group.status === 'active')); setGroupsError(null); } })
      .catch((error) => { if (!cancelled) setGroupsError(error instanceof Error ? error.message : '그룹 목록을 불러오지 못했습니다.'); })
      .finally(() => { if (!cancelled) setGroupsLoading(false); });
    return () => { cancelled = true; };
  }, []);

  React.useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

  React.useEffect(() => {
    window.setTimeout(() => {
      suppressCanvasDirtyRef.current = false;
    }, 0);
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    pluginsApi
      .list()
      .then((items) => {
        if (!cancelled) {
          setPlugins(items);
        }
      })
      .catch((error) => {
        console.error('Failed to load plugins:', error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!designerTabs.some((tab) => tab.isDirty)) {
        return;
      }
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [designerTabs]);

  // 실시간 추적 인스턴스 전이 연동
  React.useEffect(() => {
    if (initialMonitorInstanceId) {
      console.log('Restoring instance for real-time tracking:', initialMonitorInstanceId);
      handleHistorySelect(initialMonitorInstanceId);
    }
  }, [initialMonitorInstanceId]);

  const activeDesignerTab = useMemo(
    () => designerTabs.find((tab) => tab.tabId === activeDesignerTabId) || designerTabs[0],
    [activeDesignerTabId, designerTabs],
  );

  const buildCurrentTabSnapshot = React.useCallback(
    (tabId = activeDesignerTabId, dirtyOverride?: boolean): DesignerTab => {
      const baseTab =
        designerTabs.find((tab) => tab.tabId === tabId) ||
        activeDesignerTab ||
        createBlankDesignerTab(tabId);
      return {
        ...baseTab,
        templateId: currentTemplateId,
        templateName: currentTemplateName,
        description: workflowDescription,
        group: workflowGroup,
        groupId: workflowGroupId,
        tags: workflowTags,
        versionNote: workflowVersionNote,
        nodes: (flowCanvasRef.current?.getNodes() || canvasNodes) as Node<CustomNodeData>[],
        edges: flowCanvasRef.current?.getEdges() || canvasEdges,
        isDirty: dirtyOverride ?? baseTab.isDirty,
      };
    },
    [
      activeDesignerTab,
      activeDesignerTabId,
      canvasEdges,
      canvasNodes,
      currentTemplateId,
      currentTemplateName,
      designerTabs,
      workflowDescription,
      workflowGroup,
      workflowGroupId,
      workflowTags,
      workflowVersionNote,
    ],
  );

  const persistActiveDesignerTab = React.useCallback(
    (dirtyOverride?: boolean) => {
      const snapshot = buildCurrentTabSnapshot(activeDesignerTabId, dirtyOverride);
      setDesignerTabs((tabs) =>
        tabs.map((tab) => (tab.tabId === activeDesignerTabId ? snapshot : tab)),
      );
      return snapshot;
    },
    [activeDesignerTabId, buildCurrentTabSnapshot],
  );

  const restoreDesignerTab = React.useCallback((tab: DesignerTab) => {
    suppressCanvasDirtyRef.current = true;
    setCurrentTemplateId(tab.templateId);
    setCurrentTemplateName(tab.templateName);
    setWorkflowDescription(tab.description);
    setWorkflowGroup(tab.group);
    setWorkflowGroupId(tab.groupId);
    setWorkflowTags(tab.tags);
    setWorkflowVersionNote(tab.versionNote);
    setSelectedNode(null);
    setNodeTestResult(null);
    setNodeTestError(null);
    setIsExecutionModalOpen(false);
    setIsExecutionPanelOpen(false);
    setExecutionInstanceId(null);
    setExecutionFormSchema(undefined);
    flowCanvasRef.current?.setNodesAndEdges(tab.nodes, tab.edges);
    // 노드를 교체한 뒤에는 항상 화면에 맞춘다.
    // (이게 없으면 18개짜리 워크플로우를 열어도 직전 viewport가 남아 첫 노드만 크게 보인다)
    // 이 경로는 선택을 해제하므로 패널은 닫힌다 → 전체 폭 기준.
    flowCanvasRef.current?.fitView(0);
    window.setTimeout(() => {
      suppressCanvasDirtyRef.current = false;
    }, 0);
  }, []);

  const handleSwitchDesignerTab = (tabId: string) => {
    if (tabId === activeDesignerTabId) {
      return;
    }
    persistActiveDesignerTab();
    const nextTab = designerTabs.find((tab) => tab.tabId === tabId);
    if (!nextTab) {
      return;
    }
    setActiveDesignerTabId(tabId);
    restoreDesignerTab(nextTab);
  };

  const handleNewDesignerTab = () => {
    const snapshot = persistActiveDesignerTab();
    const newTab = createBlankDesignerTab();
    setDesignerTabs((tabs) => tabs.map((tab) => (tab.tabId === snapshot.tabId ? snapshot : tab)).concat(newTab));
    setActiveDesignerTabId(newTab.tabId);
    restoreDesignerTab(newTab);
  };

  const handleCloseDesignerTab = async (tabId: string) => {
    const closingTab = tabId === activeDesignerTabId ? buildCurrentTabSnapshot(tabId) : designerTabs.find((tab) => tab.tabId === tabId);
    if (!closingTab) {
      return;
    }
    if (closingTab.isDirty) {
      const discard = await confirmDialog({
        title: '저장하지 않은 변경사항이 있습니다',
        description: `"${getDesignerTabTitle(closingTab)}" 탭을 닫으면 변경사항이 사라집니다.`,
        confirmLabel: '닫고 버리기',
        tone: 'danger',
      });
      if (!discard) return;
    }

    if (designerTabs.length === 1) {
      const replacement = createBlankDesignerTab(INITIAL_DESIGNER_TAB_ID);
      setDesignerTabs([replacement]);
      setActiveDesignerTabId(replacement.tabId);
      restoreDesignerTab(replacement);
      return;
    }

    const closingIndex = designerTabs.findIndex((tab) => tab.tabId === tabId);
    const remainingTabs = designerTabs.filter((tab) => tab.tabId !== tabId);
    setDesignerTabs(remainingTabs);

    if (tabId === activeDesignerTabId) {
      const nextTab = remainingTabs[Math.max(0, closingIndex - 1)] || remainingTabs[0];
      setActiveDesignerTabId(nextTab.tabId);
      restoreDesignerTab(nextTab);
    }
  };

  const markActiveDesignerTabDirty = React.useCallback(() => {
    setDesignerTabs((tabs) =>
      tabs.map((tab) => (tab.tabId === activeDesignerTabId ? { ...tab, isDirty: true } : tab)),
    );
  }, [activeDesignerTabId]);

  const handleCopySelectedSubflow = React.useCallback(() => {
    const nodes = (flowCanvasRef.current?.getNodes() || canvasNodes) as Node<CustomNodeData>[];
    const edges = flowCanvasRef.current?.getEdges() || canvasEdges;
    const selectedNodes = nodes.filter((node) => node.selected || node.id === selectedNode?.id);
    if (selectedNodes.length === 0) {
      toast.info('복사할 노드를 먼저 선택하세요.');
      return;
    }

    const selectedIds = new Set(selectedNodes.map((node) => node.id));
    const selectedEdges = edges.filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target));
    setWorkflowClipboard({
      sourceTabId: activeDesignerTabId,
      sourceTemplateName: currentTemplateName || 'Untitled Workflow',
      copiedAt: new Date().toISOString(),
      nodes: selectedNodes.map(cloneNodeForClipboard),
      edges: selectedEdges.map(cloneEdgeForClipboard),
    });
  }, [activeDesignerTabId, canvasEdges, canvasNodes, currentTemplateName, selectedNode, toast]);

  const handlePasteSubflow = React.useCallback(() => {
    if (!workflowClipboard) {
      return;
    }
    const currentNodes = (flowCanvasRef.current?.getNodes() || canvasNodes) as Node<CustomNodeData>[];
    const currentEdges = flowCanvasRef.current?.getEdges() || canvasEdges;
    const existingIds = new Set([
      ...currentNodes.map((node) => node.id),
      ...currentEdges.map((edge) => edge.id),
    ]);
    const pasted = remapClipboardGraph(workflowClipboard, existingIds);
    flowCanvasRef.current?.appendNodesAndEdges(pasted.nodes, pasted.edges);
    setCanvasNodes((nodes) => nodes.concat(pasted.nodes));
    setCanvasEdges((edges) => edges.concat(pasted.edges));
    setSelectedNode(pasted.nodes[0] || null);
    markActiveDesignerTabDirty();
  }, [canvasEdges, canvasNodes, markActiveDesignerTabDirty, workflowClipboard]);

  const handleCanvasNodesChange = React.useCallback(
    (nodes: Node[]) => {
      setCanvasNodes(nodes as Node<CustomNodeData>[]);
      if (!traceInstanceId && !suppressCanvasDirtyRef.current) {
        markActiveDesignerTabDirty();
      }
    },
    [markActiveDesignerTabDirty, traceInstanceId],
  );

  const handleCanvasEdgesChange = React.useCallback(
    (edges: Edge[]) => {
      setCanvasEdges(edges);
      if (!traceInstanceId && !suppressCanvasDirtyRef.current) {
        markActiveDesignerTabDirty();
      }
    },
    [markActiveDesignerTabDirty, traceInstanceId],
  );

  const handleMetadataChange = <K extends 'description' | 'group' | 'tags' | 'versionNote'>(
    field: K,
    setter: React.Dispatch<React.SetStateAction<string>>,
  ) => (value: string) => {
    setter(value);
    setDesignerTabs((tabs) =>
      tabs.map((tab) =>
        tab.tabId === activeDesignerTabId
          ? { ...tab, [field]: value, isDirty: true }
          : tab,
      ),
    );
  };

  const handleGroupSelection = (groupId: string) => {
    const group = availableGroups.find((item) => item.id === groupId);
    setWorkflowGroupId(groupId);
    setWorkflowGroup(group?.name || '');
    setDesignerTabs((tabs) => tabs.map((tab) => tab.tabId === activeDesignerTabId
      ? { ...tab, groupId, group: group?.name || '', isDirty: true }
      : tab));
  };

  React.useEffect(() => {
    if (
      currentUser.role === 'group_manager' &&
      availableGroups.length === 1 &&
      !workflowGroupId &&
      !currentTemplateId
    ) {
      handleGroupSelection(availableGroups[0].id);
    }
  }, [availableGroups, currentTemplateId, currentUser.role, workflowGroupId]);

  const handleRun = async (formData?: Record<string, any>) => {
    if (!currentTemplateId) {
      toast.info('먼저 템플릿을 저장하거나 불러와주세요.');
      return;
    }

    // formData가 없으면 Start 노드에 폼이 있는지 확인
    if (!formData) {
      const nodes = flowCanvasRef.current?.getNodes() || [];
      const startNode = nodes.find(n => n.data.nodeType === 'start');
      
      if (startNode?.data.formSchema && startNode.data.formSchema.fields.length > 0) {
        // 폼이 있으면 실행 모달을 열어서 폼을 먼저 표시
        setExecutionFormSchema(JSON.parse(JSON.stringify(startNode.data.formSchema)));
        setExecutionInstanceId(null); // 아직 실행 전
        setIsExecutionModalOpen(true);
        return;
      }
    }

    try {
      // formData 정리 (circular reference 제거)
      let cleanFormData: Record<string, any> | undefined = undefined;
      if (formData) {
        cleanFormData = {};
        Object.keys(formData).forEach(key => {
          const value = formData[key];
          if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
            cleanFormData![key] = value;
          } else if (Array.isArray(value)) {
            cleanFormData![key] = value.filter(v => 
              typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null
            );
          }
        });
      }
      
      const result = await templatesApi.execute(currentTemplateId, cleanFormData);
      
      setExecutionInstanceId(result.instance_id);
      // 실행 시작 후에는 패널로 표시
      setIsExecutionModalOpen(false);
      setIsExecutionPanelOpen(true);
      setIsPropertiesPanelOpen(true);
      
      connectSSE(result.instance_id);
      console.log('Workflow execution started:', result);
    } catch (error) {
      console.error('Failed to execute workflow:', error);
      toast.error('워크플로우 실행에 실패했습니다.', { description: errorMessage(error) });
    }
  };

  const connectSSE = (instanceId: string) => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    // 상대 경로 /api/instances/... 사용
    const eventSource = new EventSource(`/api/instances/${instanceId}/stream`);
    eventSourceRef.current = eventSource;

    const handleEvent = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        console.log('SSE Event (Canvas):', data);

        const nodes = flowCanvasRef.current?.getNodes() || [];
        let targetNodeId = data.node_id || data.payload?.node_id;

        // ID 불일치 대응: 이벤트의 노드 ID가 캔버스에 없으면, 실행 중인 노드를 찾아 매핑
        if (targetNodeId && !nodes.find(n => n.id === targetNodeId)) {
          if (data.type === 'NODE_FAILED' || data.type === 'NODE_COMPLETED') {
            // 1. 실행 중인 노드 찾기
            let fallbackNode = nodes.find(n => n.data.executionStatus === 'running');

            // 2. 타입 기반 추론 (targetNodeId에 타입 이름이 포함된 경우)
            if (!fallbackNode && typeof targetNodeId === 'string') {
              const lowerId = targetNodeId.toLowerCase();
              let typeToSearch = '';
              if (lowerId.includes('service')) typeToSearch = 'service';
              else if (lowerId.includes('timer')) typeToSearch = 'timer';
              else if (lowerId.includes('gateway')) typeToSearch = 'gateway';

              if (typeToSearch) {
                const candidates = nodes.filter(n => n.data.nodeType === typeToSearch);
                // 해당 타입의 노드가 딱 하나만 있을 때만 매칭 (오탐 방지)
                if (candidates.length === 1) {
                  fallbackNode = candidates[0];
                }
              }
            }

            if (fallbackNode) {
              console.warn(`Node ID mismatch: event node_id=${targetNodeId} not found, using fallback node=${fallbackNode.id}`);
              targetNodeId = fallbackNode.id;
            }
          }
        }

        if (data.type === 'NODE_STARTED' && targetNodeId) {
          updateNodeExecutionStatus(targetNodeId, 'running');
        } else if (data.type === 'NODE_COMPLETED' && targetNodeId) {
          updateNodeExecutionStatus(targetNodeId, 'completed');
        } else if (data.type === 'NODE_FAILED' && targetNodeId) {
          updateNodeExecutionStatus(targetNodeId, 'failed');
        }

        if (data.type === 'INSTANCE_COMPLETED' || data.type === 'INSTANCE_FAILED') {
          setTimeout(() => {
            eventSource.close();
          }, 1000);
        }
      } catch (err) {
        console.error('Failed to parse SSE event:', err);
      }
    };

    const eventTypes = [
      'INSTANCE_CREATED', 'INSTANCE_RUNNING', 'INSTANCE_WAITING', 'INSTANCE_COMPLETED', 'INSTANCE_FAILED',
      'NODE_STARTED', 'NODE_COMPLETED', 'NODE_FAILED',
      'TIMER_SCHEDULED', 'TIMER_ESCALATED', 'RETRY_SCHEDULED', 'APPROVAL_REQUIRED',
    ];

    eventTypes.forEach((eventType) => {
      eventSource.addEventListener(eventType, handleEvent);
    });

    eventSource.onmessage = handleEvent;
    eventSource.onerror = (err) => {
      console.error('SSE Error:', err);
      eventSource.close();
    };
  };

  // 이벤트 큐 처리
  const processEventQueue = React.useCallback(() => {
    if (isProcessingRef.current || eventQueueRef.current.length === 0) {
      return;
    }

    isProcessingRef.current = true;
    const event = eventQueueRef.current.shift()!;
    const { nodeId, status } = event;

    if (status === 'completed') {
      // 1. 엣지 애니메이션 시작
      flowCanvasRef.current?.updateEdgesByNodeStatus(nodeId, 'running');
      
      // 2. 1.2초 후 노드 완료 표시
      setTimeout(() => {
        flowCanvasRef.current?.updateNodeData(nodeId, { executionStatus: status });
        flowCanvasRef.current?.updateEdgesByNodeStatus(nodeId, status);
        
        // 3. 약간의 여유 시간 후 다음 이벤트 처리
        setTimeout(() => {
          isProcessingRef.current = false;
          processEventQueue();
        }, 300); // 다음 노드 시작 전 짧은 대기
      }, 1200);
    } else {
      // running, failed 등은 즉시 처리
      flowCanvasRef.current?.updateNodeData(nodeId, { executionStatus: status });
      flowCanvasRef.current?.updateEdgesByNodeStatus(nodeId, status);
      
      setTimeout(() => {
        isProcessingRef.current = false;
        processEventQueue();
      }, 100);
    }
  }, []);

  const updateNodeExecutionStatus = React.useCallback((nodeId: string, status: 'pending' | 'running' | 'completed' | 'failed') => {
    // 이벤트를 큐에 추가
    eventQueueRef.current.push({ nodeId, status });
    processEventQueue();
  }, [processEventQueue]);

  const handleSave = async () => {
    const nodes = flowCanvasRef.current?.getNodes() || [];
    const edges = flowCanvasRef.current?.getEdges() || [];

    const templateName = await promptDialog({
      title: '워크플로우 저장',
      label: '워크플로우 이름',
      defaultValue: currentTemplateName || 'New Workflow',
      placeholder: '예: IT 권한 신청',
      confirmLabel: '저장',
    });
    if (!templateName) return;
    if (!workflowGroupId) {
      toast.error('관리 그룹을 먼저 선택해 주세요.', { description: '워크플로우는 관리 그룹 없이 저장할 수 없습니다.' });
      setSelectedNode(null);
      setIsPropertiesPanelOpen(true);
      return;
    }

    try {
      if (currentTemplateId) {
        const updated = await templatesApi.update(currentTemplateId, {
          name: templateName,
          description: workflowDescription,
          group: workflowGroup,
          group_id: workflowGroupId,
          tags: parseTagList(workflowTags),
          version_note: workflowVersionNote,
          nodes,
          edges,
        });
        setCurrentTemplateName(updated.name);
        setDesignerTabs((tabs) =>
          tabs.map((tab) =>
            tab.tabId === activeDesignerTabId
              ? {
                  ...tab,
                  templateId: updated.id,
                  templateName: updated.name,
                  templateVersion: updated.version,
                  lifecycleStatus: updated.lifecycle_status,
                  activePublishedVersion: updated.active_published_version,
                  hasUnpublishedChanges: updated.has_unpublished_changes,
                  description: updated.description || '',
                  group: updated.group || '',
                  groupId: updated.group_id || '',
                  tags: (updated.tags || []).join(', '),
                  versionNote: updated.version_note || '',
                  nodes: updated.nodes as Node<CustomNodeData>[],
                  edges: updated.edges,
                  isDirty: false,
                }
              : tab,
          ),
        );
        toast.success('워크플로우를 저장했습니다.', { description: `${updated.name} · v${updated.version}` });
      } else {
        const created = await templatesApi.create({
          name: templateName,
          description: workflowDescription,
          group: workflowGroup,
          group_id: workflowGroupId,
          tags: parseTagList(workflowTags),
          version_note: workflowVersionNote,
          nodes,
          edges,
        });
        setCurrentTemplateId(created.id);
        setCurrentTemplateName(created.name);
        setDesignerTabs((tabs) =>
          tabs.map((tab) =>
            tab.tabId === activeDesignerTabId
              ? {
                  ...tab,
                  templateId: created.id,
                  templateName: created.name,
                  templateVersion: created.version,
                  lifecycleStatus: created.lifecycle_status,
                  activePublishedVersion: created.active_published_version,
                  hasUnpublishedChanges: created.has_unpublished_changes,
                  description: created.description || '',
                  group: created.group || '',
                  groupId: created.group_id || '',
                  tags: (created.tags || []).join(', '),
                  versionNote: created.version_note || '',
                  nodes: created.nodes as Node<CustomNodeData>[],
                  edges: created.edges,
                  isDirty: false,
                }
              : tab,
          ),
        );
        toast.success('워크플로우를 저장했습니다.', { description: created.name });
      }
    } catch (error) {
      console.error('Failed to save template:', error);
      toast.error('워크플로우 저장에 실패했습니다.', { description: errorMessage(error) });
    }
  };

  const handleLoad = () => {
    setIsTemplateModalOpen(true);
  };

  const handleExport = async () => {
    if (!currentTemplateId) {
      toast.info('먼저 템플릿을 저장하거나 불러와주세요.');
      return;
    }

    try {
      const document = await templatesApi.export(currentTemplateId);
      downloadJson(document, `${safeFileName(document.workflow.name)}.pxm-workflow.json`);
    } catch (error) {
      console.error('Failed to export workflow:', error);
      toast.error('워크플로우 내보내기에 실패했습니다.', { description: errorMessage(error) });
    }
  };

  const handleImport = () => {
    importFileInputRef.current?.click();
  };

  const handleImportFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    try {
      const text = await file.text();
      const document = JSON.parse(text);
      const imported = await templatesApi.import(document);
      openTemplateInDesignerTab(imported);
      toast.success('워크플로우를 가져왔습니다.', { description: imported.name });
    } catch (error) {
      console.error('Failed to import workflow:', error);
      toast.error('워크플로우 가져오기에 실패했습니다.', { description: errorMessage(error) });
    }
  };

  const handleHistory = () => {
    setIsHistoryModalOpen(true);
  };

  const handleTemplateSelect = (template: WorkflowTemplate) => {
    openTemplateInDesignerTab(template);
  };

  const openTemplateInDesignerTab = (template: WorkflowTemplate) => {
    const existingTab = designerTabs.find((tab) => tab.templateId === template.id);
    persistActiveDesignerTab();

    if (existingTab) {
      const refreshedTab = createDesignerTabFromTemplate(template, existingTab.tabId);
      setDesignerTabs((tabs) =>
        tabs.map((tab) => (tab.tabId === existingTab.tabId ? refreshedTab : tab)),
      );
      setActiveDesignerTabId(existingTab.tabId);
      restoreDesignerTab(refreshedTab);
      return;
    }

    const newTab = createDesignerTabFromTemplate(template);
    setDesignerTabs((tabs) => tabs.concat(newTab));
    setActiveDesignerTabId(newTab.tabId);
    restoreDesignerTab(newTab);
  };

  const handleHistorySelect = async (instanceId: string) => {
    try {
      // 1. 인스턴스 상세 정보 조회 (ctx 복원을 위해)
      const res = await fetch(`/api/instances/${instanceId}`);
      if (!res.ok) throw new Error('Failed to fetch instance details');
      const instance = await res.json();
      const fallbackContext = instance.ctx || instance.context || {};
      const fallbackRuntime = fallbackContext.runtime || fallbackContext;
      const templateId = instance.template_id || instance.definition_id || fallbackRuntime.template_id || null;
      const templateName = instance.template_name || fallbackRuntime.template_name || fallbackRuntime.snapshot?.workflow?.name || '워크플로우';

      // ctx에서 nodes/edges 복원
      const runtimeContext = fallbackRuntime;
      if (runtimeContext && runtimeContext.nodes && runtimeContext.edges) {
        flowCanvasRef.current?.setNodesAndEdges(runtimeContext.nodes, runtimeContext.edges);
        setCanvasNodes(runtimeContext.nodes);
        setCanvasEdges(runtimeContext.edges);
        window.setTimeout(() => flowCanvasRef.current?.fitView(), 0);
      }
      setCurrentTemplateId(templateId);
      setCurrentTemplateName(templateName);
      setDesignerTabs((tabs) => tabs.map((tab) => tab.tabId === activeDesignerTabId ? {
        ...tab,
        templateId,
        templateName,
        nodes: runtimeContext?.nodes || tab.nodes,
        edges: runtimeContext?.edges || tab.edges,
        isDirty: false,
        traceInstanceId: instanceId,
      } : tab));
      
      // 2. 실행 상태 패널 열기 및 SSE 연결
      setExecutionInstanceId(instanceId);
      setTraceInstanceId(instanceId);
      setIsExecutionPanelOpen(true);
      setIsPropertiesPanelOpen(true);
      connectSSE(instanceId);
      setIsHistoryModalOpen(false);
      
    } catch (error) {
      console.error('Failed to restore history:', error);
      toast.error('실행 이력을 불러오지 못했습니다.', { description: errorMessage(error) });
    }
  };

  const handleSettings = () => {
    setSelectedNode(null);
    setIsExecutionPanelOpen(false);
    setIsPropertiesPanelOpen(true);
  };

  const handleToggleDarkMode = () => {
    setDarkMode(!darkMode);
  };

  // 패널이 열리면 가려지는 폭을 뺀 영역에, 닫히면 전체 폭에 다시 맞춘다.
  // 개폐 순간에만 움직이므로 노드를 바꿔 선택해도 화면이 흔들리지 않는다.
  const previousPanelOpenRef = useRef(isPropertiesPanelOpen);
  React.useEffect(() => {
    if (previousPanelOpenRef.current === isPropertiesPanelOpen) return;
    previousPanelOpenRef.current = isPropertiesPanelOpen;
    flowCanvasRef.current?.fitView(isPropertiesPanelOpen ? PROPERTIES_PANEL_WIDTH : 0);
  }, [isPropertiesPanelOpen]);

  const togglePalette = () => setIsPaletteOpen((current) => {
    localStorage.setItem('pxm.designer.palette', current ? 'rail' : 'open');
    return !current;
  });

  const handleNodeSelect = (node: Node | null) => {
    if (node?.id !== selectedNode?.id) {
      setNodeTestResult(null);
      setNodeTestError(null);
    }
    setSelectedNode(node as Node<CustomNodeData> | null);
    if (node) {
      setIsPropertiesPanelOpen(true);
      return;
    }

    if (!isExecutionPanelOpen) {
      setIsPropertiesPanelOpen(false);
    }
  };

  const handleNodeUpdate = (nodeId: string, data: Partial<CustomNodeData>) => {
    flowCanvasRef.current?.updateNodeData(nodeId, data);
  };

  const handleGatewayEdgeUpdate = (edgeId: string, data: Partial<Edge>) => {
    flowCanvasRef.current?.updateEdgeData(edgeId, data);
  };

  const handleSelectedNodeTest = async () => {
    if (!selectedNode || selectedNode.data.nodeType !== 'service') {
      return;
    }

    const pluginId = selectedNode.data.plugin_id || CORE_PLUGIN_ID;
    setIsNodeTestRunning(true);
    setNodeTestResult(null);
    setNodeTestError(null);

    try {
      const result = await pluginsApi.test({
        plugin_id: pluginId,
        node_id: selectedNode.id,
        config: selectedNode.data as unknown as Record<string, unknown>,
        input: {},
      });
      setNodeTestResult(result);
      if (!result.ok) {
        setNodeTestError(result.error || '테스트 실행에 실패했습니다.');
      }
    } catch (error) {
      setNodeTestError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsNodeTestRunning(false);
    }
  };

  const onDragStart = (event: React.DragEvent, nodeType: string, label: string, extraData?: Partial<CustomNodeData>) => {
    const nodeData: CustomNodeData = {
      label,
      nodeType: nodeType as CustomNodeData['nodeType'],
      description: `${label} 노드`,
      ...extraData,
    };
    event.dataTransfer.setData('application/reactflow', JSON.stringify(nodeData));
    event.dataTransfer.effectAllowed = 'move';
  };

  const onPluginDragStart = (event: React.DragEvent, plugin: PluginManifest) => {
    const defaults = getPluginConfigDefaults(plugin);
    onDragStart(event, 'service', plugin.display_name, {
      ...defaults,
      description: plugin.description || plugin.category,
      plugin_id: plugin.plugin_id,
      plugin_version: plugin.version,
      icon: plugin.icon,
      category: plugin.category,
      timeout: plugin.timeout_ms,
      retryCount: plugin.retry_policy?.max_attempts,
      enableRetry: !!plugin.retry_policy?.max_attempts,
    });
  };

  const toggleFavoritePlugin = (pluginId: string) => {
    setFavoritePluginIds((current) => {
      const next = current.includes(pluginId)
        ? current.filter((id) => id !== pluginId)
        : [...current, pluginId];
      localStorage.setItem('pxm.favoritePlugins', JSON.stringify(next));
      return next;
    });
  };

  const filteredPlugins = useMemo(() => {
    const query = pluginSearch.trim().toLowerCase();
    return plugins.filter((plugin) => {
      if (!query) return true;
      return [
        plugin.display_name,
        plugin.plugin_id,
        plugin.category,
        ...(plugin.tags || []),
      ]
        .join(' ')
        .toLowerCase()
        .includes(query);
    });
  }, [plugins, pluginSearch]);

  const favoritePlugins = useMemo(
    () => filteredPlugins.filter((plugin) => plugin.plugin_id !== CORE_PLUGIN_ID && favoritePluginIds.includes(plugin.plugin_id)),
    [filteredPlugins, favoritePluginIds],
  );

  const pluginsByCategory = useMemo(() => {
    return filteredPlugins.reduce<Record<string, PluginManifest[]>>((groups, plugin) => {
      if (plugin.plugin_id === CORE_PLUGIN_ID || favoritePluginIds.includes(plugin.plugin_id)) {
        return groups;
      }
      const category = plugin.category || 'Other';
      groups[category] = groups[category] || [];
      groups[category].push(plugin);
      return groups;
    }, {});
  }, [filteredPlugins, favoritePluginIds]);

  const selectedGatewayEdges = useMemo(() => {
    if (!selectedNode || selectedNode.data.nodeType !== 'gateway') {
      return [];
    }
    return canvasEdges.filter((edge) => edge.source === selectedNode.id);
  }, [canvasEdges, selectedNode]);

  const selectedNodePathSuggestions = useMemo(() => {
    if (!selectedNode) {
      return [];
    }
    return buildPreviousNodePathSuggestions(selectedNode, canvasNodes, canvasEdges, plugins);
  }, [canvasEdges, canvasNodes, plugins, selectedNode]);

  return (
    <div className={`flow-designer${traceInstanceId ? ' trace-mode' : ''}`}>
      <Header
        workflowName={traceInstanceId ? `실행 추적 · ${currentTemplateName || '워크플로우'}` : currentTemplateName || undefined}
        statusLabel={traceInstanceId ? undefined : activeDesignerTab?.lifecycleStatus === 'PUBLISHED'
          ? publishedLabel(activeDesignerTab.activePublishedVersion)
          : activeDesignerTab?.lifecycleStatus === 'DISABLED'
            ? '배포 중지'
            : currentTemplateId ? '초안' : undefined}
        dirty={!traceInstanceId && Boolean(activeDesignerTab?.isDirty)}
        actions={(
          <>
            {traceInstanceId && <div className="trace-mode-badge"><span>READ ONLY</span><strong>{currentTemplateName || '워크플로우'} · {shortInstanceId(traceInstanceId)}</strong></div>}
            {!traceInstanceId && currentTemplateId && <Button variant="ghost" icon={<Braces />} onClick={() => { window.location.hash = `#/presets?workflow=${encodeURIComponent(currentTemplateId)}`; }}>
              실행 프리셋
            </Button>}
            {onSwitchToInbox && <Button variant="ghost" icon={<Inbox />} onClick={() => onSwitchToInbox()}>
              내 결재함
            </Button>}
          </>
        )}
        onRun={traceInstanceId ? undefined : () => handleRun()}
        onSave={traceInstanceId ? undefined : handleSave}
        onLoad={traceInstanceId ? undefined : handleLoad}
        onImport={traceInstanceId ? undefined : handleImport}
        onExport={traceInstanceId ? undefined : handleExport}
        onHistory={handleHistory}
        onSettings={traceInstanceId ? undefined : handleSettings}
        darkMode={darkMode}
        onToggleDarkMode={handleToggleDarkMode}
      />
      <div className="workflow-tab-bar" role="tablist" aria-label="열린 워크플로우">
        <div className="workflow-tabs">
          {designerTabs.filter((tab) => !traceInstanceId || tab.tabId === activeDesignerTabId).map((tab) => (
            <div
              key={tab.tabId}
              className={`workflow-tab ${tab.tabId === activeDesignerTabId ? 'active' : ''}`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={tab.tabId === activeDesignerTabId}
                className="workflow-tab-main"
                onClick={() => handleSwitchDesignerTab(tab.tabId)}
                title={getDesignerTabTitle(tab)}
              >
                <span className="workflow-tab-status" aria-hidden="true">
                  {tab.isDirty ? '●' : ''}
                </span>
                <span className="workflow-tab-title">{getDesignerTabTitle(tab)}</span>
                {tab.templateVersion && <span className="workflow-tab-version">v{tab.templateVersion}</span>}
                {tab.lifecycleStatus && (
                  <span className={`workflow-tab-lifecycle ${tab.lifecycleStatus.toLowerCase()}`}>
                    {tab.lifecycleStatus === 'PUBLISHED'
                      ? publishedLabel(tab.activePublishedVersion)
                      : tab.lifecycleStatus === 'DISABLED'
                        ? '배포 중지'
                        : '초안'}
                  </span>
                )}
                {tab.hasUnpublishedChanges && <span className="workflow-tab-unpublished">미배포</span>}
              </button>
              {!traceInstanceId && <button
                type="button"
                className="workflow-tab-close"
                aria-label={`${getDesignerTabTitle(tab)} 탭 닫기`}
                title="탭 닫기"
                onClick={(event) => {
                  event.stopPropagation();
                  handleCloseDesignerTab(tab.tabId);
                }}
              >
                <X size={13} />
              </button>}
            </div>
          ))}
        </div>
        {!traceInstanceId && <button
          type="button"
          className="workflow-tab-add"
          onClick={handleNewDesignerTab}
          aria-label="새 워크플로우 탭"
          title="새 워크플로우 탭"
        >
          <Plus size={15} />
        </button>}
        {!traceInstanceId && <div className="workflow-tab-tools" aria-label="워크플로우 복사 도구">
          <button
            type="button"
            className="workflow-tab-tool"
            onClick={handleCopySelectedSubflow}
            title="선택 노드 복사"
            aria-label="선택 노드 복사"
          >
            <Clipboard size={14} />
          </button>
          <button
            type="button"
            className="workflow-tab-tool"
            onClick={handlePasteSubflow}
            disabled={!workflowClipboard}
            title={
              workflowClipboard
                ? `${workflowClipboard.sourceTemplateName}에서 복사한 ${workflowClipboard.nodes.length}개 노드 붙여넣기`
                : '복사한 노드가 없습니다'
            }
            aria-label="복사한 노드 붙여넣기"
          >
            <ClipboardPaste size={14} />
            {workflowClipboard && <span>{workflowClipboard.nodes.length}</span>}
          </button>
        </div>}
      </div>
      <input
        ref={importFileInputRef}
        type="file"
        accept="application/json,.json,.pxm-workflow.json"
        className="workflow-import-input"
        onChange={handleImportFileChange}
      />

      <div className={`flow-designer-content${isPropertiesPanelOpen ? '' : ' properties-collapsed'}${traceInstanceId ? ' trace-content' : ''}`}>
        {!traceInstanceId && <aside className={`node-palette${isPaletteOpen ? '' : ' rail'}`}>
          <div className="palette-header">
            <h3 className="palette-title">노드</h3>
            <button
              type="button"
              className="palette-toggle"
              onClick={togglePalette}
              aria-label={isPaletteOpen ? '노드 팔레트 접기' : '노드 팔레트 펼치기'}
              title={isPaletteOpen ? '접기' : '펼치기'}
            >
              {isPaletteOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
            </button>
          </div>
          <div className="palette-content">
            <div className="palette-section palette-section-basic">
              <h4 className="palette-section-title">기본 노드</h4>
              <div className="palette-nodes">
                <div className="palette-node" draggable title="Start · 워크플로우 시작 (Manual · Schedule · DB Watch)" onDragStart={(e) => onDragStart(e, 'start', 'Start')}>
                  <div className="palette-node-icon" style={{ background: 'var(--node-start)' }}><Play size={16} fill="currentColor" /></div>
                  <div className="palette-node-text">
                    <span className="palette-node-label">Start</span>
                    <span className="palette-node-caption">Manual · Schedule · DB Watch</span>
                  </div>
                </div>
                <div className="palette-node" draggable title="Timer · 지정 시간 대기" onDragStart={(e) => onDragStart(e, 'timer', 'Timer')}>
                  <div className="palette-node-icon" style={{ background: 'var(--node-timer)' }}><Clock size={16} /></div>
                  <span className="palette-node-label">Timer</span>
                </div>
                <div
                  className="palette-node"
                  title="JS Node · JavaScript 실행"
                  draggable
                  onDragStart={(e) =>
                    onDragStart(e, 'script', 'JS Node', {
                      scriptType: 'javascript',
                      code: "return { message: 'hello from js node', formData: input.formData };",
                      outputPath: 'scriptResults.jsNode',
                      scriptTimeoutMs: 1000,
                    })
                  }
                >
                  <div className="palette-node-icon" style={{ background: 'var(--node-script)' }}><Braces size={16} /></div>
                  <span className="palette-node-label">JS Node</span>
                </div>
                <div
                  className="palette-node"
                  title="Command · 허용된 명령어 실행"
                  draggable
                  onDragStart={(e) =>
                    onDragStart(e, 'command', 'Command', {
                      description: 'Allowlist command 실행',
                      commandId: 'builtin.echo',
                      commandArgumentsJson: '{\n  "message": "hello from command node"\n}',
                      outputPath: 'commandResults.echo',
                      commandTimeoutMs: 1000,
                    })
                  }
                >
                  <div className="palette-node-icon" style={{ background: 'var(--node-command)' }}><Terminal size={16} /></div>
                  <span className="palette-node-label">Command</span>
                </div>
                <div className="palette-node" draggable title="Gateway · 조건 분기" onDragStart={(e) => onDragStart(e, 'gateway', 'Gateway')}>
                  <div className="palette-node-icon" style={{ background: 'var(--node-gateway)' }}><Diamond size={16} fill="currentColor" /></div>
                  <span className="palette-node-label">Gateway</span>
                </div>
                <div className="palette-node" draggable title="Approval · 결재 요청" onDragStart={(e) => onDragStart(e, 'approval', 'Approval')}>
                  <div className="palette-node-icon" style={{ background: 'var(--node-approval)' }}><CheckSquare size={16} /></div>
                  <span className="palette-node-label">Approval</span>
                </div>
                <div
                  className="palette-node"
                  title="Workflow Call · 다른 워크플로우 호출"
                  draggable
                  onDragStart={(e) =>
                    onDragStart(e, 'workflow_call', 'Workflow Call', {
                      description: '다른 워크플로우 호출',
                      workflowCallMode: 'async',
                      workflowInputMode: 'inherit_form_data',
                      outputPath: 'workflowCalls.child',
                    })
                  }
                >
                  <div className="palette-node-icon" style={{ background: 'var(--node-workflow-call)' }}><Workflow size={16} /></div>
                  <span className="palette-node-label">Workflow Call</span>
                </div>
                <div className="palette-node" draggable title="End · 워크플로우 종료" onDragStart={(e) => onDragStart(e, 'end', 'End')}>
                  <div className="palette-node-icon" style={{ background: 'var(--node-end)' }}><CircleCheck size={16} /></div>
                  <span className="palette-node-label">End</span>
                </div>
              </div>
            </div>

            <div className="palette-section palette-section-plugins">
              <h4 className="palette-section-title">플러그인 노드</h4>
              <div className="palette-search">
                <Search size={14} />
                <input
                  value={pluginSearch}
                  onChange={(event) => setPluginSearch(event.target.value)}
                  placeholder="Search plugins"
                />
              </div>
              {favoritePlugins.length > 0 && (
                <PluginPaletteSection
                  title="Favorites"
                  plugins={favoritePlugins}
                  favoritePluginIds={favoritePluginIds}
                  onDragStart={onPluginDragStart}
                  onToggleFavorite={toggleFavoritePlugin}
                />
              )}
              <PluginPaletteSection
                title="Core"
                plugins={getCorePlugins(filteredPlugins)}
                favoritePluginIds={favoritePluginIds}
                onDragStart={onPluginDragStart}
                onToggleFavorite={toggleFavoritePlugin}
              />
              {Object.entries(pluginsByCategory).map(([category, categoryPlugins]) => (
                <PluginPaletteSection
                  key={category}
                  title={category}
                  plugins={categoryPlugins}
                  favoritePluginIds={favoritePluginIds}
                  onDragStart={onPluginDragStart}
                  onToggleFavorite={toggleFavoritePlugin}
                />
              ))}
            </div>
          </div>
          <button
            type="button"
            className="palette-rail-search"
            onClick={() => setIsPaletteOpen(true)}
            aria-label="플러그인 노드 검색"
            title="플러그인 노드 검색"
          >
            <Search size={16} />
          </button>
        </aside>}

        <main className="canvas">
          <FlowCanvas
            ref={flowCanvasRef}
            onNodeSelect={handleNodeSelect}
            onNodesChange={handleCanvasNodesChange}
            onEdgesChange={handleCanvasEdgesChange}
            readOnly={Boolean(traceInstanceId)}
          />
        </main>

        {!isPropertiesPanelOpen && (
          <button
            type="button"
            className="properties-reopen"
            onClick={() => setIsPropertiesPanelOpen(true)}
            aria-label="속성 패널 열기"
            title={selectedNode ? `${selectedNode.data.label} 속성` : '워크플로우 설정'}
          >
            <PanelRightOpen size={16} />
          </button>
        )}

        <aside className={`properties-panel${isPropertiesPanelOpen ? '' : ' collapsed'}`}>
          {isExecutionPanelOpen ? (
            <ExecutionPanel
              instanceId={executionInstanceId}
              templateId={currentTemplateId}
              templateName={currentTemplateName}
              formSchema={executionFormSchema}
              onFormSubmit={(formData) => handleRun(formData)}
              onClose={() => {
                if (traceInstanceId && onExitTrace) {
                  onExitTrace();
                  return;
                }
                setIsExecutionPanelOpen(false);
                setExecutionInstanceId(null);
                setExecutionFormSchema(undefined);
              }}
            />
          ) : (
            <>
              <div className="properties-header">
                <div className="properties-title-group">
                  <h3 className="properties-title">속성 패널</h3>
                  {selectedNode && (
                    <span className="properties-subtitle">{selectedNode.data.label}</span>
                  )}
                </div>
                <button
                  type="button"
                  className="properties-toggle-button"
                  onClick={() => setIsPropertiesPanelOpen((current) => !current)}
                  aria-label={isPropertiesPanelOpen ? '속성 패널 접기' : '속성 패널 펼치기'}
                  title={isPropertiesPanelOpen ? '속성 패널 접기' : '속성 패널 펼치기'}
                >
                  {isPropertiesPanelOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
                </button>
              </div>
              {isPropertiesPanelOpen && (
                <div className="properties-content">
                  {selectedNode ? (
                    <NodePropertiesForm
                      node={selectedNode}
                      onUpdate={handleNodeUpdate}
                    plugins={plugins}
                    gatewayEdges={selectedGatewayEdges}
                    pathSuggestions={selectedNodePathSuggestions}
                    onGatewayEdgeUpdate={handleGatewayEdgeUpdate}
                    onTestRun={handleSelectedNodeTest}
                    testRunning={isNodeTestRunning}
                    testResult={nodeTestResult}
                    testError={nodeTestError}
                    credentialGroupId={workflowGroupId}
                    workflowGroups={availableGroups}
                    workflowGroupsLoading={groupsLoading}
                    workflowGroupsError={groupsError}
                    onWorkflowGroupChange={handleGroupSelection}
                  />
                  ) : (
                    <WorkflowMetadataForm
                      description={workflowDescription}
                      group={workflowGroup}
                      groupId={workflowGroupId}
                      groups={availableGroups}
                      groupsLoading={groupsLoading}
                      groupsError={groupsError}
                      tags={workflowTags}
                      versionNote={workflowVersionNote}
                      onDescriptionChange={handleMetadataChange('description', setWorkflowDescription)}
                      onGroupChange={handleGroupSelection}
                      onTagsChange={handleMetadataChange('tags', setWorkflowTags)}
                      onVersionNoteChange={handleMetadataChange('versionNote', setWorkflowVersionNote)}
                    />
                  )}
                </div>
              )}
            </>
          )}
        </aside>
      </div>

      <TemplateListModal
        isOpen={isTemplateModalOpen}
        onClose={() => setIsTemplateModalOpen(false)}
        onSelect={handleTemplateSelect}
        allowedGroupIds={currentUser.role === 'admin' ? undefined : availableGroups.map((group) => group.id)}
      />

      <HistoryListModal
        isOpen={isHistoryModalOpen}
        onClose={() => setIsHistoryModalOpen(false)}
        onSelect={handleHistorySelect}
      />

      <ExecutionModal
        isOpen={isExecutionModalOpen}
        instanceId={executionInstanceId}
        templateId={currentTemplateId}
        templateName={currentTemplateName}
        formSchema={executionFormSchema}
        onFormSubmit={(formData) => handleRun(formData)}
        onClose={() => setIsExecutionModalOpen(false)}
      />
    </div>
  );
};

const CORE_PLUGIN_ID = 'builtin.http_request';

const DEFAULT_DESIGNER_NODES: Node<CustomNodeData>[] = [
  {
    id: '1',
    type: 'custom',
    position: { x: 100, y: 100 },
    data: { label: 'Start', nodeType: 'start', description: '워크플로우 시작' },
  },
];

const DEFAULT_DESIGNER_EDGES: Edge[] = [];

function createBlankDesignerTab(tabId = createDesignerTabId()): DesignerTab {
  return {
    tabId,
    templateId: null,
    templateName: '',
    description: '',
    group: '',
    groupId: '',
    tags: '',
    versionNote: '',
    nodes: cloneWorkflowNodes(DEFAULT_DESIGNER_NODES),
    edges: cloneWorkflowEdges(DEFAULT_DESIGNER_EDGES),
    isDirty: false,
  };
}

function createDesignerTabFromTemplate(template: WorkflowTemplate, tabId = createDesignerTabId()): DesignerTab {
  return {
    tabId,
    templateId: template.id,
    templateName: template.name,
    templateVersion: template.version,
    lifecycleStatus: template.lifecycle_status,
    activePublishedVersion: template.active_published_version,
    hasUnpublishedChanges: template.has_unpublished_changes,
    description: template.description || '',
    group: template.group || '',
    groupId: template.group_id || '',
    tags: (template.tags || []).join(', '),
    versionNote: template.version_note || '',
    nodes: cloneWorkflowNodes(template.nodes as Node<CustomNodeData>[]),
    edges: cloneWorkflowEdges(template.edges),
    isDirty: false,
  };
}

function createDesignerTabId() {
  return `designer-tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getDesignerTabTitle(tab: DesignerTab) {
  const title = tab.templateName || 'Untitled Workflow';
  return tab.traceInstanceId ? `${title} · ${shortInstanceId(tab.traceInstanceId)}` : title;
}

// lifecycle_status가 PUBLISHED여도 active_published_version이 비어 있는 데이터가 있다.
// 그 경우 'v null'을 찍는 대신 버전 없이 '배포'만 표시한다.
// .properties-panel 의 clamp(360px, 26vw, 440px) 상한과 맞춘다.
const PROPERTIES_PANEL_WIDTH = 440;

function publishedLabel(version?: number | null) {
  return typeof version === 'number' ? `배포 v${version}` : '배포';
}

function shortInstanceId(instanceId: string) {
  return instanceId.length > 16 ? `${instanceId.slice(0, 8)}…${instanceId.slice(-6)}` : instanceId;
}

function cloneWorkflowNodes(nodes: Node<CustomNodeData>[]) {
  return JSON.parse(JSON.stringify(nodes || [])) as Node<CustomNodeData>[];
}

function cloneWorkflowEdges(edges: Edge[]) {
  return JSON.parse(JSON.stringify(edges || [])) as Edge[];
}

function getCorePlugins(plugins: PluginManifest[]) {
  return plugins.filter((plugin) => plugin.plugin_id === CORE_PLUGIN_ID);
}

function getPluginConfigDefaults(plugin: PluginManifest): Partial<CustomNodeData> {
  const defaults: Record<string, unknown> = {};
  Object.entries(plugin.config_schema.properties || {}).forEach(([key, property]) => {
    if (property.default !== undefined) {
      defaults[key] = property.default;
    }
  });
  return defaults as Partial<CustomNodeData>;
}

function buildPreviousNodePathSuggestions(
  selectedNode: Node<CustomNodeData>,
  nodes: Node<CustomNodeData>[],
  edges: Edge[],
  plugins: PluginManifest[],
): NodePathSuggestion[] {
  const incomingEdges = edges.filter((edge) => edge.target === selectedNode.id);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const suggestions: NodePathSuggestion[] = [];

  for (const edge of incomingEdges) {
    const sourceNode = nodeById.get(edge.source);
    if (!sourceNode) {
      continue;
    }
    suggestions.push(...buildNodeOutputSuggestions(sourceNode, plugins));
  }

  const seen = new Set<string>();
  return suggestions.filter((suggestion) => {
    const key = `${suggestion.sourceNodeId}:${suggestion.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildNodeOutputSuggestions(
  node: Node<CustomNodeData>,
  plugins: PluginManifest[],
): NodePathSuggestion[] {
  const data = node.data as Record<string, any>;
  const sourceNodeLabel = node.data.label || node.id;

  if (node.data.nodeType === 'start') {
    const fields = node.data.formSchema?.fields || [];
    return fields.map((field) => ({
      label: `${sourceNodeLabel} · ${field.label || field.id}`,
      path: `data.formData.${field.id}`,
      sourceNodeId: node.id,
      sourceNodeLabel,
    }));
  }

  const outputPath = getConfiguredOutputPath(data, node);
  if (!outputPath) {
    return [];
  }

  const baseSuggestion: NodePathSuggestion = {
    label: `${sourceNodeLabel} · output`,
    path: outputPath,
    sourceNodeId: node.id,
    sourceNodeLabel,
  };

  if (node.data.nodeType === 'script') {
    return [baseSuggestion];
  }

  if (node.data.nodeType !== 'service') {
    return [];
  }

  const plugin = plugins.find((item) => item.plugin_id === data.plugin_id);
  const schemaProperties = plugin?.output_schema?.properties || {};
  const schemaPaths = Object.keys(schemaProperties).map((key) => ({
    label: `${sourceNodeLabel} · ${key}`,
    path: `${outputPath}.${key}`,
    sourceNodeId: node.id,
    sourceNodeLabel,
  }));

  return [baseSuggestion, ...schemaPaths];
}

function getConfiguredOutputPath(data: Record<string, any>, node: Node<CustomNodeData>) {
  const value = data.outputPath || data.output_path;
  if (typeof value === 'string' && value.trim()) {
    return normalizeContextPath(value);
  }
  if (node.data.nodeType === 'script') {
    return `scriptResults.${node.id}`;
  }
  return '';
}

function normalizeContextPath(path: string) {
  return path.trim().replace(/^context\./, '');
}

function parseTagList(value: string): string[] {
  return value
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function safeFileName(value: string) {
  const trimmed = value.trim().replace(/[^a-zA-Z0-9가-힣._-]+/g, '-').replace(/^-+|-+$/g, '');
  return trimmed || 'workflow';
}

function cloneNodeForClipboard(node: Node<CustomNodeData>): Node<CustomNodeData> {
  return {
    ...node,
    selected: false,
    dragging: false,
    data: {
      ...node.data,
      executionStatus: undefined,
    },
  };
}

function cloneEdgeForClipboard(edge: Edge): Edge {
  return {
    ...edge,
    selected: false,
    animated: edge.animated,
    data: edge.data ? { ...edge.data } : edge.data,
    style: edge.style ? { ...edge.style } : edge.style,
  };
}

function remapClipboardGraph(clipboard: WorkflowClipboard, existingIds: Set<string>) {
  const idMap = new Map<string, string>();
  const timestamp = Date.now();
  const nextId = (prefix: string) => {
    let index = 0;
    let candidate = '';
    do {
      candidate = `${prefix}-${timestamp}-${index++}`;
    } while (existingIds.has(candidate));
    existingIds.add(candidate);
    return candidate;
  };

  const nodes = clipboard.nodes.map((node, index) => {
    const nodeId = nextId(`copy-${node.id}`);
    idMap.set(node.id, nodeId);
    return {
      ...cloneNodeForClipboard(node),
      id: nodeId,
      position: {
        x: node.position.x + 56,
        y: node.position.y + 56 + index * 4,
      },
      selected: index === 0,
      data: {
        ...node.data,
        label: node.data?.label ? `${node.data.label} copy` : 'Copied node',
        executionStatus: undefined,
      },
    };
  });

  const edges = clipboard.edges
    .filter((edge) => idMap.has(edge.source) && idMap.has(edge.target))
    .map((edge) => ({
      ...cloneEdgeForClipboard(edge),
      id: nextId(`copy-${edge.id}`),
      source: idMap.get(edge.source)!,
      target: idMap.get(edge.target)!,
      selected: false,
    }));

  return { nodes, edges };
}

function WorkflowMetadataForm({
  description,
  group,
  groupId,
  groups,
  groupsLoading,
  groupsError,
  tags,
  versionNote,
  onDescriptionChange,
  onGroupChange,
  onTagsChange,
  onVersionNoteChange,
}: {
  description: string;
  group: string;
  groupId: string;
  groups: PxmGroup[];
  groupsLoading: boolean;
  groupsError: string | null;
  tags: string;
  versionNote: string;
  onDescriptionChange: (value: string) => void;
  onGroupChange: (value: string) => void;
  onTagsChange: (value: string) => void;
  onVersionNoteChange: (value: string) => void;
}) {
  return (
    <div className="workflow-metadata-form">
      <div className="property-section">
        <h4 className="property-section-title">워크플로우 메타데이터</h4>
        <div className="property-group">
          <label className="property-label">Description</label>
          <textarea
            className="property-textarea"
            value={description}
            onChange={(event) => onDescriptionChange(event.target.value)}
            placeholder="워크플로우 목적과 사용 조건"
            rows={4}
          />
        </div>
        <div className="property-group">
          <label className="property-label" htmlFor="workflow-group-id">관리 그룹</label>
          <select
            id="workflow-group-id"
            className="property-select"
            value={groupId}
            onChange={(event) => onGroupChange(event.target.value)}
            disabled={groupsLoading || Boolean(groupsError)}
          >
            <option value="">{groupsLoading ? '그룹 불러오는 중…' : '그룹을 선택하세요'}</option>
            {groups.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          {groupId && <span className="property-helper-text">Group ID: {groupId}</span>}
          {!groupId && group && <span className="property-warning-text">기존 그룹명 “{group}”은 권한 그룹과 연결되지 않았습니다. 저장 전 그룹을 선택하세요.</span>}
          {groupsError && <span className="property-warning-text">{groupsError}</span>}
          {!groupsLoading && !groupsError && groups.length === 0 && <span className="property-warning-text">관리 가능한 활성 그룹이 없습니다. Access Management에서 그룹을 먼저 생성하세요.</span>}
        </div>
        <Input
          label="Tags"
          value={tags}
          onChange={(event) => onTagsChange(event.target.value)}
          placeholder="approval, onboarding, account"
          helperText="쉼표로 구분합니다."
          fullWidth
        />
        <div className="property-group">
          <label className="property-label">Version Note</label>
          <textarea
            className="property-textarea"
            value={versionNote}
            onChange={(event) => onVersionNoteChange(event.target.value)}
            placeholder="이번 버전의 변경 내용"
            rows={3}
          />
        </div>
      </div>
    </div>
  );
}

function PluginPaletteSection({
  title,
  plugins,
  favoritePluginIds,
  onDragStart,
  onToggleFavorite,
}: {
  title: string;
  plugins: PluginManifest[];
  favoritePluginIds: string[];
  onDragStart: (event: React.DragEvent, plugin: PluginManifest) => void;
  onToggleFavorite: (pluginId: string) => void;
}) {
  return (
    <div className="plugin-category">
      <h5 className="plugin-category-title">{title}</h5>
      <div className="palette-nodes">
        {plugins.map((plugin) => {
          const isFavorite = favoritePluginIds.includes(plugin.plugin_id);
          return (
            <div
              key={plugin.plugin_id}
              className="palette-node plugin-palette-node"
              draggable
              onDragStart={(event) => onDragStart(event, plugin)}
            >
              <div className="palette-node-icon plugin-node-icon">
                <PluginIcon icon={plugin.icon} size={16} />
              </div>
              <div className="palette-node-text">
                <span className="palette-node-label">{plugin.display_name}</span>
                <span className="palette-node-caption">{plugin.executor_type}</span>
              </div>
              <button
                type="button"
                className={`favorite-plugin-button ${isFavorite ? 'active' : ''}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleFavorite(plugin.plugin_id);
                }}
                title={isFavorite ? 'Remove favorite' : 'Add favorite'}
              >
                <Star size={13} fill={isFavorite ? 'currentColor' : 'none'} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
