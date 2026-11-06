import {
  ChevronDown,
  ChevronRight,
  FolderEditIcon,
  FolderIcon,
  FolderOpenIcon,
  MoreHorizontal,
  Trash2,
} from "lucide-react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { useThreadManagement } from "@/hooks/useThreadManagement"
import { useThreads } from "@/hooks/useThreads"
import { Link, useNavigate, useParams } from "@tanstack/react-router"


import { useMemo, useState } from "react"
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { ThreadFolder } from "@/services/projects/types"
import AddProjectDialog from "@/containers/dialogs/AddProjectDialog"
import { DeleteProjectDialog } from "@/containers/dialogs/DeleteProjectDialog"
import ThreadList from "@/containers/ThreadList"

// Fork: un progetto si apre a tendina con i suoi thread più recenti, come
// nella barra laterale di Claude; gli altri restano nella pagina del progetto.
const PROJECT_THREADS_SHOWN = 10
const NO_THREADS: Thread[] = []

function ProjectItem({
  item,
  threads,
  currentThreadId,
  isProjectPage,
  isMobile,
  onEdit,
  onDelete,
}: {
  item: ThreadFolder
  threads: Thread[]
  currentThreadId?: string
  isProjectPage: boolean
  isMobile: boolean
  onEdit: (project: ThreadFolder) => void
  onDelete: (project: ThreadFolder) => void
}) {

  const navigate = useNavigate()

  // La tendina si apre da sola quando il thread a schermo è di questo progetto.
  const containsCurrent = threads.some((thread) => thread.id === currentThreadId)
  const [open, setOpen] = useState(containsCurrent)
  const [prevContainsCurrent, setPrevContainsCurrent] = useState(containsCurrent)
  if (containsCurrent !== prevContainsCurrent) {
    setPrevContainsCurrent(containsCurrent)
    if (containsCurrent) setOpen(true)
  }

  // I più recenti, più il thread a schermo se è più vecchio: così resta
  // sempre evidenziato nella barra.
  const shownThreads = useMemo(() => {
    const shown = threads.slice(0, PROJECT_THREADS_SHOWN)
    const current = threads.find((thread) => thread.id === currentThreadId)
    if (current && !shown.includes(current)) shown.push(current)
    return shown
  }, [threads, currentThreadId])

  return (
    <>
    <SidebarMenuItem>
      {/* Nome: apre la pagina del progetto e la tendina. Icona: apre e
          chiude la tendina senza cambiare pagina (freccia al passaggio). */}
      <SidebarMenuButton asChild isActive={isProjectPage}>
        <Link
          to="/project/$projectId"
          params={{ projectId: item.id }}
          onClick={() => setOpen(true)}
        >
          <span
            role="button"
            aria-expanded={open}
            aria-label={open ? "Chiudi la tendina" : "Apri la tendina"}
            className="group/icon flex shrink-0 items-center"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setOpen((o) => !o)
            }}
          >
            {open
              ? <FolderOpenIcon className="text-foreground/70 group-hover/icon:hidden" size={16} />
              : <FolderIcon className="text-foreground/70 group-hover/icon:hidden" size={16} />}
            {open
              ? <ChevronDown className="hidden text-foreground/70 group-hover/icon:block" size={16} />
              : <ChevronRight className="hidden text-foreground/70 group-hover/icon:block" size={16} />}
          </span>
          <span>{item.name}</span>
        </Link>
      </SidebarMenuButton>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuAction showOnHover className="hover:bg-sidebar-foreground/8">
            <MoreHorizontal />
            <span className="sr-only">More</span>
          </SidebarMenuAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className="w-48"
          side={isMobile ? "bottom" : "right"}
          align={isMobile ? "end" : "start"}
        >
          <DropdownMenuItem onSelect={() => {
            navigate({ to: '/project/$projectId', params: { projectId: item.id } })
          }}>
            <FolderOpenIcon className="text-muted-foreground" />
            <span>View Project</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onEdit(item)}>
            <FolderEditIcon className="text-muted-foreground" />
            <span>Edit Project</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => onDelete(item)}>
            <Trash2 />
            <span>Delete Project</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
    {/* Fuori dal <li> del progetto: dentro, l'hover del progetto
        mostrerebbe il menu "..." di tutti i suoi thread. */}
    {open && shownThreads.length > 0 && (
      <li>
        <SidebarMenu className="pl-6">
          <ThreadList threads={shownThreads} />
          {threads.length > PROJECT_THREADS_SHOWN && (
            <SidebarMenuItem>
              <SidebarMenuButton asChild className="text-muted-foreground">
                <Link to="/project/$projectId" params={{ projectId: item.id }}>
                  <span>Visualizza tutto</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
        </SidebarMenu>
      </li>
    )}
    </>
  )
}

export function NavProjects() {
  const { t } = useTranslation()
  const { isMobile } = useSidebar()
  const { folders, updateFolder } = useThreadManagement()
  const threads = useThreads((state) => state.threads)
  const currentThreadId = useParams({
    strict: false,
    select: (params) => params.threadId,
  })
  const currentProjectId = useParams({
    strict: false,
    select: (params) => params.projectId,
  })

  // Stesso filtro e stesso ordine della pagina del progetto.
  const threadsByProject = useMemo(() => {
    const byProject: Record<string, Thread[]> = {}
    for (const thread of Object.values(threads)) {
      const projectId = thread.metadata?.project?.id
      if (!projectId) continue
      if (!byProject[projectId]) byProject[projectId] = []
      byProject[projectId].push(thread)
    }
    for (const list of Object.values(byProject)) {
      list.sort((a, b) => (b.updated || 0) - (a.updated || 0))
    }
    return byProject
  }, [threads])

  const [editDialogOpen, setEditDialogOpen] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [selectedProject, setSelectedProject] = useState<ThreadFolder | null>(null)

  const handleEdit = (project: ThreadFolder) => {
    setSelectedProject(project)
    setEditDialogOpen(true)
  }

  const handleDelete = (project: ThreadFolder) => {
    setSelectedProject(project)
    setDeleteDialogOpen(true)
  }

  const handleSaveEdit = async (name: string, assistantId?: string) => {
    if (selectedProject) {
      await updateFolder(selectedProject.id, name, assistantId)
      setEditDialogOpen(false)
      setSelectedProject(null)
    }
  }

  if (folders.length === 0) {
    return null
  }

  return (
    <>
      <SidebarGroup className="group-data-[collapsible=icon]:hidden">
        <SidebarGroupLabel>{t('common:projects.title')}</SidebarGroupLabel>
        <SidebarMenu>
          {folders.map((item) => (
            <ProjectItem
              key={item.id}
              item={item}
              threads={threadsByProject[item.id] ?? NO_THREADS}
              currentThreadId={currentThreadId}
              isProjectPage={currentProjectId === item.id}
              isMobile={isMobile}
              onEdit={handleEdit}
              onDelete={handleDelete}
            />
          ))}
        </SidebarMenu>
      </SidebarGroup>

      <AddProjectDialog
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        editingKey={selectedProject?.id ?? null}
        initialData={selectedProject ?? undefined}
        onSave={handleSaveEdit}
      />

      <DeleteProjectDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        projectId={selectedProject?.id}
        projectName={selectedProject?.name}
      />
    </>
  )
}
