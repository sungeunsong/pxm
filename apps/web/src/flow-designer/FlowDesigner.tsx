import React, { useMemo, useState, useRef } from 'react';
import type { Node } from 'reactflow';
import type { Edge } from 'reactflow';
import { Braces, CheckSquare, CircleCheck, Clipboard, ClipboardPaste, Clock, Diamond, Inbox, PanelRightClose, PanelRightOpen, Play, Plus, Search, Star, Terminal, Workflow, X } from 'lucide-react';
import { Button } from '../components/Button';
import { Header } from '../components/Header';
import { Input } from '../components/Input';
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
import { pluginsApi } from '../api/plugins';
import type { PluginManifest, PluginTestResponse } from '../api/plugins';
import { PluginIcon } from './plugin-icons';
import './FlowDesigner.css';

export interface FlowDesignerProps {
  children?: React.ReactNode;
  onSwitchToInbox?: () => void;
  initialMonitorInstanceId?: string;
}

type DesignerTab = {
  tabId: string;
  templateId: string | null;
  templateName: string;
  templateVersion?: number;
  description: string;
  group: string;
  groupId: string;
  tags: string;
  versionNote: string;
  nodes: Node<CustomNodeData>[];
  edges: Edge[];
  isDirty: boolean;
};

const INITIAL_DESIGNER_TAB_ID = 'designer-tab-initial';

type WorkflowClipboard = {
  sourceTabId: string;
  sourceTemplateName: string;
  copiedAt: string;
  nodes: Node<CustomNodeData>[];
  edges: Edge[];
};

export const FlowDesigner: React.FC<FlowDesignerProps> = ({ onSwitchToInbox, initialMonitorInstanceId }) => {
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
  const [isPropertiesPanelOpen, setIsPropertiesPanelOpen] = useState(true);
  const [isHistoryModalOpen, setIsHistoryModalOpen] = useState(false);
  const [executionInstanceId, setExecutionInstanceId] = useState<string | null>(null);
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
    authzApi.listGroups(false)
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

  const handleCloseDesignerTab = (tabId: string) => {
    const closingTab = tabId === activeDesignerTabId ? buildCurrentTabSnapshot(tabId) : designerTabs.find((tab) => tab.tabId === tabId);
    if (!closingTab) {
      return;
    }
    if (closingTab.isDirty && !window.confirm(`"${getDesignerTabTitle(closingTab)}" 탭의 저장하지 않은 변경사항을 버릴까요?`)) {
      return;
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
      window.alert('복사할 노드를 먼저 선택하세요.');
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
  }, [activeDesignerTabId, canvasEdges, canvasNodes, currentTemplateName, selectedNode]);

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
      if (!suppressCanvasDirtyRef.current) {
        markActiveDesignerTabDirty();
      }
    },
    [markActiveDesignerTabDirty],
  );

  const handleCanvasEdgesChange = React.useCallback(
    (edges: Edge[]) => {
      setCanvasEdges(edges);
      if (!suppressCanvasDirtyRef.current) {
        markActiveDesignerTabDirty();
      }
    },
    [markActiveDesignerTabDirty],
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

  const handleRun = async (formData?: Record<string, any>) => {
    if (!currentTemplateId) {
      alert('먼저 템플릿을 저장하거나 불러와주세요.');
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
      alert('워크플로우 실행에 실패했습니다.');
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

    const templateName = prompt('템플릿 이름을 입력하세요:', currentTemplateName || 'New Workflow');
    if (!templateName) return;
    if (!workflowGroupId) {
      alert('워크플로우를 저장하려면 관리 그룹을 선택해야 합니다.');
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
        alert(`템플릿이 업데이트되었습니다: ${updated.name} (v${updated.version})`);
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
        alert(`템플릿이 저장되었습니다: ${created.name}`);
      }
    } catch (error) {
      console.error('Failed to save template:', error);
      alert('템플릿 저장에 실패했습니다.');
    }
  };

  const handleLoad = () => {
    setIsTemplateModalOpen(true);
  };

  const handleExport = async () => {
    if (!currentTemplateId) {
      alert('먼저 템플릿을 저장하거나 불러와주세요.');
      return;
    }

    try {
      const document = await templatesApi.export(currentTemplateId);
      downloadJson(document, `${safeFileName(document.workflow.name)}.pxm-workflow.json`);
    } catch (error) {
      console.error('Failed to export workflow:', error);
      alert('워크플로우 내보내기에 실패했습니다.');
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
      alert(`워크플로우를 가져왔습니다: ${imported.name}`);
    } catch (error) {
      console.error('Failed to import workflow:', error);
      alert(error instanceof Error ? `워크플로우 가져오기에 실패했습니다: ${error.message}` : '워크플로우 가져오기에 실패했습니다.');
    }
  };

  const handleHistory = () => {
    setIsHistoryModalOpen(true);
  };

  const handleTemplateSelect = (template: WorkflowTemplate) => {
    openTemplateInDesignerTab(template);
    alert(`템플릿 "${template.name}"을 불러왔습니다.`);
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
      
      // ctx에서 nodes/edges 복원
      const runtimeContext = instance.ctx?.runtime || instance.context?.runtime || instance.ctx || instance.context;
      if (runtimeContext && runtimeContext.nodes && runtimeContext.edges) {
        flowCanvasRef.current?.setNodesAndEdges(runtimeContext.nodes, runtimeContext.edges);
        
        // 템플릿 정보도 업데이트 (선택 사항)
        if (instance.template_id) {
          setCurrentTemplateId(instance.template_id);
          // 템플릿 이름은 별도로 가져오거나 instance 정보에 없다면 스킵
        }
      }
      
      // 2. 실행 상태 패널 열기 및 SSE 연결
      setExecutionInstanceId(instanceId);
      setIsExecutionPanelOpen(true);
      setIsPropertiesPanelOpen(true);
      connectSSE(instanceId);
      setIsHistoryModalOpen(false);
      
    } catch (error) {
      console.error('Failed to restore history:', error);
      alert('실행 이력을 불러오는 데 실패했습니다.');
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
    <div className="flow-designer">
      <Header
        title="PXM Flow Designer"
        actions={
          <Button variant="ghost" icon={<Inbox />} onClick={() => onSwitchToInbox?.()}>
            내 결재함
          </Button>
        }
        onRun={() => handleRun()}
        onSave={handleSave}
        onLoad={handleLoad}
        onImport={handleImport}
        onExport={handleExport}
        onHistory={handleHistory}
        onSettings={handleSettings}
        darkMode={darkMode}
        onToggleDarkMode={handleToggleDarkMode}
      />
      <div className="workflow-tab-bar" role="tablist" aria-label="열린 워크플로우">
        <div className="workflow-tabs">
          {designerTabs.map((tab) => (
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
              </button>
              <button
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
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="workflow-tab-add"
          onClick={handleNewDesignerTab}
          aria-label="새 워크플로우 탭"
          title="새 워크플로우 탭"
        >
          <Plus size={15} />
        </button>
        <div className="workflow-tab-tools" aria-label="워크플로우 복사 도구">
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
        </div>
      </div>
      <input
        ref={importFileInputRef}
        type="file"
        accept="application/json,.json,.pxm-workflow.json"
        className="workflow-import-input"
        onChange={handleImportFileChange}
      />

      <div className={`flow-designer-content${isPropertiesPanelOpen ? '' : ' properties-collapsed'}`}>
        <aside className="node-palette">
          <div className="palette-header">
            <h3 className="palette-title">노드 팔레트</h3>
          </div>
          <div className="palette-content">
            <div className="palette-section">
              <h4 className="palette-section-title">기본 노드</h4>
              <div className="palette-nodes">
                <div className="palette-node" draggable onDragStart={(e) => onDragStart(e, 'start', 'Start')}>
                  <div className="palette-node-icon" style={{ background: 'var(--node-start)' }}><Play size={16} fill="currentColor" /></div>
                  <div className="palette-node-text">
                    <span className="palette-node-label">Start</span>
                    <span className="palette-node-caption">Manual · Schedule · DB Watch</span>
                  </div>
                </div>
                <div className="palette-node" draggable onDragStart={(e) => onDragStart(e, 'timer', 'Timer')}>
                  <div className="palette-node-icon" style={{ background: 'var(--node-timer)' }}><Clock size={16} /></div>
                  <span className="palette-node-label">Timer</span>
                </div>
                <div
                  className="palette-node"
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
                <div className="palette-node" draggable onDragStart={(e) => onDragStart(e, 'gateway', 'Gateway')}>
                  <div className="palette-node-icon" style={{ background: 'var(--node-gateway)' }}><Diamond size={16} fill="currentColor" /></div>
                  <span className="palette-node-label">Gateway</span>
                </div>
                <div className="palette-node" draggable onDragStart={(e) => onDragStart(e, 'approval', 'Approval')}>
                  <div className="palette-node-icon" style={{ background: 'var(--node-approval)' }}><CheckSquare size={16} /></div>
                  <span className="palette-node-label">Approval</span>
                </div>
                <div
                  className="palette-node"
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
                <div className="palette-node" draggable onDragStart={(e) => onDragStart(e, 'end', 'End')}>
                  <div className="palette-node-icon" style={{ background: 'var(--node-end)' }}><CircleCheck size={16} /></div>
                  <span className="palette-node-label">End</span>
                </div>
              </div>
            </div>

            <div className="palette-section">
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
        </aside>

        <main className="canvas">
          <FlowCanvas
            ref={flowCanvasRef}
            onNodeSelect={handleNodeSelect}
            onNodesChange={handleCanvasNodesChange}
            onEdgesChange={handleCanvasEdgesChange}
          />
        </main>

        <aside className={`properties-panel${isPropertiesPanelOpen ? '' : ' collapsed'}`}>
          {isExecutionPanelOpen ? (
            <ExecutionPanel
              instanceId={executionInstanceId}
              templateId={currentTemplateId}
              templateName={currentTemplateName}
              formSchema={executionFormSchema}
              onFormSubmit={(formData) => handleRun(formData)}
              onClose={() => {
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
  return tab.templateName || 'Untitled Workflow';
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
