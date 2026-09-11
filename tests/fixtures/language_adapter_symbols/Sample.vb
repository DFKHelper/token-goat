' FORMAT-DERIVED: assembled from the code examples on Microsoft Learn's Visual Basic reference pages: https://learn.microsoft.com/en-us/dotnet/visual-basic/language-reference/statements/property-statement (Class1/Prop1 and SampleCollection) and https://learn.microsoft.com/en-us/dotnet/visual-basic/language-reference/statements/declare-statement (GetUserName), wrapped in a Namespace/Module written from the same reference, not from any adapter regex.
Imports System.Collections.Generic

Namespace Samples
    Class Class1
        ' Define a local variable to store the property value.
        Private propertyValue As String
        ' Define the property.
        Public Property Prop1() As String
            Get
                ' The Get property procedure is called when the value
                ' of a property is retrieved.
                Return propertyValue
            End Get
            Set(ByVal value As String)
                ' The Set property procedure is called when the value
                ' of a property is modified.  The value to be assigned
                ' is passed in the argument to Set.
                propertyValue = value
            End Set
        End Property
    End Class

    Class SampleCollection
        ' Define a local collection to store strings.
        Private items As New List(Of String)

        ' Define a parameterized property (indexer) for the collection.
        Default Public Property Item(ByVal index As Integer) As String
            Get
                ' Return the item at the specified index.
                If index >= 0 AndAlso index < items.Count Then
                    Return items(index)
                Else
                    Return Nothing
                End If
            End Get
            Set(ByVal value As String)
                ' Set the item at the specified index.
                If index >= 0 AndAlso index < items.Count Then
                    items(index) = value
                ElseIf index = items.Count Then
                    ' Allow adding new items at the end.
                    items.Add(value)
                End If
            End Set
        End Property

        ' Add a Count property for convenience.
        Public ReadOnly Property Count As Integer
            Get
                Return items.Count
            End Get
        End Property

        ' Add method to add items.
        Public Sub Add(ByVal item As String)
            items.Add(item)
        End Sub
    End Class

    Module UserInfo
        Declare Function GetUserName Lib "advapi32.dll" Alias "GetUserNameA" (
            ByVal lpBuffer As String, ByRef nSize As Integer) As Integer
        Sub GetUser()
            Dim buffer As String = New String(CChar(" "), 25)
            Dim retVal As Integer = GetUserName(buffer, 25)
            Dim userName As String = Strings.Left(buffer, InStr(buffer, Chr(0)) - 1)
            MsgBox(userName)
        End Sub
    End Module
End Namespace
