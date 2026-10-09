'use client'


import { IconPlus } from '@/components/ui/icons'

import { useState, useEffect, useCallback, useRef } from 'react'
import { PageTransition } from '@/components/PageTransition'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { Table } from '@/components/ui/Table'
import { Modal } from '@/components/ui/Modal'
import { Badge } from '@/components/ui/Badge'
import { Skeleton } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/ui/EmptyState'
import { Toast } from '@/components/ui/Toast'
import { apiFetch } from '@/lib/api-client'

interface Supplier {
  _id: string
  name: string
  contactPerson?: string
  phone?: string
  email?: string
  city: string
  address?: string
  productsSupplied: string[]
  notes?: string
  isActive: boolean
  createdAt: string
  updatedAt: string
}

const CITIES = [
  { value: 'sheikhupura', label: 'Sheikhupura' },
  { value: 'lahore', label: 'Lahore' },
  { value: 'other', label: 'Other' },
]

export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const isSubmittingRef = useRef(false)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null)
  const [toastMessage, setToastMessage] = useState<{
    type: 'success' | 'error' | 'info' | 'warning'
    message: string
  } | null>(null)

  // Form state preserved across modal open/close
  const [formName, setFormName] = useState('')
  const [formContactPerson, setFormContactPerson] = useState('')
  const [formPhone, setFormPhone] = useState('')
  const [formEmail, setFormEmail] = useState('')
  const [formCity, setFormCity] = useState('sheikhupura')
  const [formAddress, setFormAddress] = useState('')
  const [formProductsSupplied, setFormProductsSupplied] = useState('')
  const [formNotes, setFormNotes] = useState('')
  const [formIsActive, setFormIsActive] = useState(true)
  const [formErrors, setFormErrors] = useState<Record<string, string>>({})

  const fetchSuppliers = useCallback(async () => {
    try {
      setLoading(true)
      setLoadError(null)
      const res = await apiFetch('/api/suppliers')
      const body = await res.json()
      if (!res.ok || !body.success) {
        throw new Error(body?.error?.message || 'Failed to load suppliers')
      }
      setSuppliers(body.data)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load suppliers')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSuppliers()
  }, [fetchSuppliers])

  const resetForm = () => {
    setFormName('')
    setFormContactPerson('')
    setFormPhone('')
    setFormEmail('')
    setFormCity('sheikhupura')
    setFormAddress('')
    setFormProductsSupplied('')
    setFormNotes('')
    setFormIsActive(true)
    setFormErrors({})
    setEditingSupplier(null)
  }

  const openModal = () => {
    resetForm()
    setIsModalOpen(true)
  }

  const openEditModal = (supplier: Supplier) => {
    setEditingSupplier(supplier)
    setFormName(supplier.name)
    setFormContactPerson(supplier.contactPerson || '')
    setFormPhone(supplier.phone || '')
    setFormEmail(supplier.email || '')
    setFormCity(supplier.city)
    setFormAddress(supplier.address || '')
    setFormProductsSupplied(supplier.productsSupplied.join(', '))
    setFormNotes(supplier.notes || '')
    setFormIsActive(supplier.isActive)
    setFormErrors({})
    setIsModalOpen(true)
  }

  const closeModal = () => {
    setIsModalOpen(false)
    resetForm()
  }

  const validateForm = (): boolean => {
    const errors: Record<string, string> = {}
    if (!formName.trim()) errors.name = 'Name is required'
    if (!formContactPerson.trim()) errors.contactPerson = 'Contact person is required'
    if (!formPhone.trim()) errors.phone = 'Phone is required'
    if (!formCity.trim()) errors.city = 'City is required'
    if (!formAddress.trim()) errors.address = 'Address is required'
    setFormErrors(errors)
    return Object.keys(errors).length === 0
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (isSubmittingRef.current) return
    if (!validateForm()) return

    isSubmittingRef.current = true
    setIsSubmitting(true)
    try {
      const payload = {
        name: formName.trim(),
        contactPerson: formContactPerson.trim() || undefined,
        phone: formPhone.trim() || undefined,
        email: formEmail.trim() || undefined,
        city: formCity.trim(),
        address: formAddress.trim() || undefined,
        productsSupplied: formProductsSupplied
          ? formProductsSupplied
              .split(',')
              .map((p) => p.trim())
              .filter(Boolean)
          : [],
        notes: formNotes.trim() || undefined,
        isActive: formIsActive,
      }

      const res = await apiFetch(editingSupplier ? `/api/suppliers/${editingSupplier._id}` : '/api/suppliers', {
        method: editingSupplier ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await res.json()

      if (!res.ok || !body.success) {
        if (Array.isArray(body?.error?.details)) {
          const fieldErrors: Record<string, string> = {}
          for (const d of body.error.details) {
            if (d?.path) fieldErrors[d.path] = d.message
          }
          setFormErrors(fieldErrors)
        }
        throw new Error(body?.error?.message || 'Could not save supplier')
      }

      setToastMessage({
        type: 'success',
        message: editingSupplier ? 'Supplier updated successfully' : 'Supplier added successfully',
      })
      closeModal()
      await fetchSuppliers()
    } catch (err) {
      setFormErrors((prev) => ({
        ...prev,
        general: err instanceof Error ? err.message : 'Could not save supplier',
      }))
    } finally {
      isSubmittingRef.current = false
      setIsSubmitting(false)
    }
  }

  const toggleActive = async (supplier: Supplier) => {
    const nextActive = !supplier.isActive
    const previous = suppliers
    setSuppliers((current) =>
      current.map((s) => (s._id === supplier._id ? { ...s, isActive: nextActive } : s))
    )

    try {
      const res = await apiFetch(`/api/suppliers/${supplier._id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: nextActive }),
      })
      const body = await res.json()
      if (!res.ok || !body.success) throw new Error(body?.error?.message || 'Could not update supplier')

      setToastMessage({ type: 'info', message: `Supplier ${nextActive ? 'activated' : 'deactivated'}` })
      await fetchSuppliers()
    } catch (err) {
      setSuppliers(previous)
      setToastMessage({
        type: 'error',
        message: err instanceof Error ? err.message : 'Could not update supplier',
      })
    }
  }

  const deleteSupplier = async (supplierId: string) => {
    if (!confirm('Are you sure you want to delete this supplier?')) return

    const previous = suppliers
    setSuppliers((current) => current.filter((s) => s._id !== supplierId))

    try {
      const res = await apiFetch(`/api/suppliers/${supplierId}`, { method: 'DELETE' })
      const body = await res.json()
      if (!res.ok || !body.success) {
        setSuppliers(previous)
        throw new Error(body?.error?.message || 'Could not delete supplier')
      }

      // A referenced supplier is deactivated by the API rather than removed.
      if (body.data?.deactivated) {
        setToastMessage({ type: 'warning', message: body.data.message })
      } else {
        setToastMessage({ type: 'success', message: 'Supplier deleted' })
      }
      await fetchSuppliers()
    } catch (err) {
      setSuppliers(previous)
      setToastMessage({
        type: 'error',
        message: err instanceof Error ? err.message : 'Could not delete supplier',
      })
    }
  }

  const columns = [
    { key: 'name', label: 'Name' },
    { key: 'contactPerson', label: 'Contact Person' },
    { key: 'phone', label: 'Phone' },
    { key: 'city', label: 'City' },
    { key: 'products', label: 'Products Supplied' },
    { key: 'status', label: 'Status' },
    { key: 'actions', label: 'Actions' },
  ]

  const tableData = suppliers.map((supplier) => ({
    name: supplier.name,
    contactPerson: supplier.contactPerson,
    phone: supplier.phone,
    city: supplier.city,
    products: supplier.productsSupplied.join(', ') || '-',
    status: (
      <Badge variant={supplier.isActive ? 'success' : 'warning'}>
        {supplier.isActive ? 'Active' : 'Inactive'}
      </Badge>
    ),
    actions: (
      <div className="flex gap-1">
        <Button variant="ghost" size="sm" onClick={() => openEditModal(supplier)} type="button"
        >
          Edit
        </Button>
        <Button variant="ghost" size="sm" onClick={() => toggleActive(supplier)} type="button"
        >
          {supplier.isActive ? 'Deactivate' : 'Activate'}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => deleteSupplier(supplier._id)} type="button"
        >
          Del
        </Button>
      </div>
    ),
  }))

  if (loading) {
    return (
      <PageTransition>
        <h1 className="text-2xl font-bold text-decoricks-dark mb-6">Suppliers</h1>
        <Skeleton variant="rect" className="h-96" />
      </PageTransition>
    )
  }

  return (
    <PageTransition>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-decoricks-dark">Suppliers</h1>
        <Button variant="primary" onClick={openModal} type="button"
        >
          <IconPlus size={16}  />
          Add Supplier
        </Button>
      </div>

      {/* Toast */}
      {toastMessage && (
        <div className="fixed top-20 right-4 z-50">
          <Toast
            message={toastMessage.message}
            type={toastMessage.type}
            onClose={() => setToastMessage(null)}
          />
        </div>
      )}

      {loadError && (
        <Card variant="default" className="p-6 mb-6 border-red-200">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold text-decoricks-dark">Could not load suppliers</h2>
              <p className="text-sm text-decoricks-dark/60">{loadError}</p>
            </div>
            <Button variant="outline" onClick={fetchSuppliers} type="button">
              Try again
            </Button>
          </div>
        </Card>
      )}

      {!loadError && suppliers.length === 0 ? (
        <EmptyState
          title="No suppliers yet"
          description="Add suppliers to manage your product supply chain. This list only shows suppliers you have added."
          action={{ label: 'Add Supplier', onClick: openModal }}
        />
      ) : (
        !loadError && (
        <Card className="mb-6">
          <div className="p-4">
            <Table columns={columns} data={tableData} />
          </div>
        </Card>
        )
      )}

      {/* Add/Edit Supplier Modal */}
      <Modal
        isOpen={isModalOpen}
        onClose={closeModal}
        title={editingSupplier ? 'Edit Supplier' : 'Add Supplier'}
        size="lg"
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label="Supplier Name"
              placeholder="Enter company name..."
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              error={formErrors.name}
            />
            <Input
              label="Contact Person"
              placeholder="Enter contact person..."
              value={formContactPerson}
              onChange={(e) => setFormContactPerson(e.target.value)}
              error={formErrors.contactPerson}
            />
            <Input
              label="Phone"
              placeholder="03XXXXXXXXX"
              value={formPhone}
              onChange={(e) => setFormPhone(e.target.value)}
              error={formErrors.phone}
            />
            <Input
              label="Email"
              type="email"
              placeholder="name@company.com"
              value={formEmail}
              onChange={(e) => setFormEmail(e.target.value)}
            />
            <Select
              label="City"
              options={CITIES}
              value={formCity}
              onChange={(e) => setFormCity(e.target.value)}
              error={formErrors.city}
            />
            <Input
              label="Address"
              placeholder="Enter full address..."
              value={formAddress}
              onChange={(e) => setFormAddress(e.target.value)}
              error={formErrors.address}
            />
            <Input
              label="Products Supplied"
              placeholder="Comma-separated list"
              value={formProductsSupplied}
              onChange={(e) => setFormProductsSupplied(e.target.value)}
            />
          </div>

          <Textarea
            label="Notes (optional)"
            placeholder="Enter notes..."
            value={formNotes}
            onChange={(e) => setFormNotes(e.target.value)}
            rows={3}
          />

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="isActive"
              checked={formIsActive}
              onChange={(e) => setFormIsActive(e.target.checked)}
              className="w-4 h-4"
            />
            <label htmlFor="isActive" className="text-sm font-medium text-decoricks-dark">
              Active
            </label>
          </div>

          {formErrors.general && <p className="text-sm text-red-500">{formErrors.general}</p>}

          <div className="flex justify-end gap-2 pt-4 border-t">
            <Button variant="outline" onClick={closeModal} type="button"
            >
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Saving…' : editingSupplier ? 'Update Supplier' : 'Add Supplier'}
            </Button>
          </div>
        </form>
      </Modal>
    </PageTransition>
  )
}
