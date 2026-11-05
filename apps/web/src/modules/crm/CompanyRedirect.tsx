import { Navigate, useParams } from 'react-router-dom';
import { useApi } from '../../lib/hooks';
import { ErrorState, LoadingBlock, PageHeader } from '../../components/ui';

/** /crm/companies/:id → lead or client page depending on the company's stage. */
export default function CompanyRedirect() {
  const { id } = useParams();
  const st = useApi<any>(`/api/v1/companies/${id}`);
  if (st.error) return <div><PageHeader title="Company" back="/crm/clients" /><ErrorState error={st.error} retry={st.reload} /></div>;
  if (!st.data) return <LoadingBlock rows={6} />;
  const lead = st.data.stage === 'lead' || st.data.stage === 'qualified';
  return <Navigate to={lead ? `/crm/leads/${id}` : `/crm/clients/${id}`} replace />;
}
