/**
 * Icon mapping over `react-icons`.
 *
 * Phase 1 hand-rolled every glyph as inline SVG. These are now the single
 * mapping layer onto `react-icons` so screens import named icons from one place
 * and the underlying set can be swapped without touching call sites.
 *
 * Icons are rendered as elements, not components, because call sites pass them
 * through as props (`icon={<IconDashboard />}`).
 */
import type { IconType } from 'react-icons'
import {
  HiOutlineChartPie,
  HiOutlineCurrencyRupee,
  HiOutlineClipboard,
  HiOutlineCog,
  HiOutlineUserGroup,
  HiOutlineChatBubbleLeftRight,
  HiOutlineDocumentText,
  HiOutlineBars3,
  HiOutlineXMark,
  HiOutlineChevronLeft,
  HiOutlineChevronRight,
  HiOutlineChevronDown,
  HiOutlineChevronUp,
  HiOutlinePlus,
  HiOutlineMagnifyingGlass,
  HiOutlinePencilSquare,
  HiOutlineTrash,
  HiOutlineCheck,
  HiOutlineArrowPath,
  HiOutlineExclamationTriangle,
  HiOutlineInbox,
  HiOutlineSignalSlash,
  HiOutlineArrowUp,
  HiOutlineArrowDown,
  HiOutlineArrowRightOnRectangle,
  HiOutlineKey,
  HiOutlineShieldCheck,
  HiOutlineEye,
  HiOutlineEyeSlash,
  HiOutlineLockClosed,
  HiOutlineUser,
  HiOutlineUsers,
  HiOutlineClock,
  HiOutlineFunnel,
  HiOutlineChevronUpDown,
  HiOutlineSparkles,
  HiOutlineInformationCircle,
  HiOutlineCheckCircle,
  HiOutlineXCircle,
  HiOutlineArrowPathRoundedSquare,
  HiOutlineCalendarDays,
  HiOutlineBanknotes,
} from 'react-icons/hi2'
import {
  LuLayoutDashboard,
  LuWallet,
  LuPackage,
  LuListTodo,
  LuMessageSquare,
  LuTruck,
  LuSettings,
  LuChartColumn,
  LuClipboard,
  LuShoppingCart,
  LuPalette,
  LuShieldCheck,
  LuScrollText,
  LuUserCog,
  LuBell,
  LuTrendingUp,
  LuArrowLeftRight,
  LuHandCoins,
  LuArrowDownToLine,
  LuArchive,
  LuMoveLeft,
  LuRotateCcw,
  LuCalculator,
  LuScale,
} from 'react-icons/lu'
import { MdLogout, MdPersonOutline } from 'react-icons/md'

export type { IconType }

/** Navigation glyphs, matched to SPEC §2.1. */
export const IconDashboard = LuLayoutDashboard
export const IconFinance = LuWallet
export const IconBudgets = LuChartColumn
export const IconInventory = LuPackage
export const IconSales = LuShoppingCart
export const IconTasks = LuListTodo
export const IconChat = LuMessageSquare
export const IconSuppliers = LuTruck
export const IconSettings = LuSettings
export const IconSummary = LuClipboard
export const IconDesign = LuPalette
export const IconProfitLoss = LuTrendingUp
export const IconCashFlow = LuArrowLeftRight
export const IconDistribution = LuHandCoins
export const IconReconciliation = LuScale

/** Chrome and controls. */
export const IconMenu = HiOutlineBars3
export const IconClose = HiOutlineXMark
export const IconChevronLeft = HiOutlineChevronLeft
export const IconChevronRight = HiOutlineChevronRight
export const IconChevronDown = HiOutlineChevronDown
export const IconChevronUp = HiOutlineChevronUp
export const IconPlus = HiOutlinePlus
export const IconSearch = HiOutlineMagnifyingGlass
export const IconEdit = HiOutlinePencilSquare
export const IconTrash = HiOutlineTrash
export const IconCheck = HiOutlineCheck
export const IconRefresh = HiOutlineArrowPath
export const IconAlert = HiOutlineExclamationTriangle
export const IconInbox = HiOutlineInbox
export const IconOffline = HiOutlineSignalSlash
export const IconArrowUp = HiOutlineArrowUp
export const IconArrowDown = HiOutlineArrowDown

/** Phase 2 additions. */
export const IconLogout = MdLogout
export const IconUser = HiOutlineUser
export const IconUsers = HiOutlineUsers
export const IconUserGroup = HiOutlineUserGroup
export const IconKey = HiOutlineKey
export const IconShieldCheck = LuShieldCheck
export const IconPermissions = LuShieldCheck
export const IconAuditLog = LuScrollText
export const IconUserCog = LuUserCog
export const IconBell = LuBell
export const IconEye = HiOutlineEye
export const IconEyeOff = HiOutlineEyeSlash
export const IconLock = HiOutlineLockClosed
export const IconClock = HiOutlineClock
export const IconFilter = HiOutlineFunnel
export const IconSwap = HiOutlineArrowPathRoundedSquare
export const IconSparkles = HiOutlineSparkles
export const IconInfo = HiOutlineInformationCircle
export const IconSuccess = HiOutlineCheckCircle
export const IconError = HiOutlineXCircle
export const IconCalendar = HiOutlineCalendarDays
export const IconMoney = HiOutlineBanknotes
export const IconProfile = MdPersonOutline
export const IconFinanceAlt = HiOutlineCurrencyRupee
export const IconPieChart = HiOutlineChartPie
export const IconCopy = LuClipboard

/** Phase 5 inventory and sales glyphs. */
export const IconExport = LuArrowDownToLine
export const IconArchive = LuArchive
export const IconTransfer = LuMoveLeft
export const IconReverseMovement = LuRotateCcw
export const IconCalculation = LuCalculator